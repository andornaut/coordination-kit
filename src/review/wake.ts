// Scheduled review for a due slot. The adapter follows the recipient's selected harness; the
// recipient (the host game's reports.recipient) and worker parents are role names resolved through
// the registry. `reviewOutcome` returns the typed outcome; `deliverScheduledReview` formats it as
// the one-line JSON status the runner logs, or an empty string when this project does not
// dispatch the slot.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";

import { accountingReview, boundaryAccounting } from "../accounting/boundary.ts";
import { claudeAdapter } from "../adapters/claude/index.ts";
import { spoolReviewBrief, unblockDir } from "../adapters/claude/spool.ts";
import { collectAll, unavailableCollected } from "../adapters/codex/collect.ts";
import { SOCKET_MISSING } from "../adapters/codex/index.ts";
import { queueEntries, queuePayload } from "../adapters/codex/inventory.ts";
import { connectControl, type RpcClient } from "../adapters/codex/rpc.ts";
import { persistSlot, previousSlot, SlotInterrupted } from "../adapters/codex/slot.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord, pyJsonDumps } from "../adapters/shared/pyjson.ts";
import { messageReview } from "../adapters/shared/review.ts";
import {
  type ActiveScope,
  activeScope,
  readRoleRoute,
  roleConversation,
  type RoleRoute,
  ROUTE_SCHEMA_1,
  RouteError,
  routeRecipient,
  sendRoute,
} from "../adapters/shared/route.ts";
import type { HarnessAdapter, Inventory } from "../adapters/types.ts";
import { loadReportsConfig } from "../config.ts";
import { readJson } from "../durable.ts";
import type { GameLayout, Layout } from "../layout.ts";
import { holdLock, LockBusy, type LockHandle } from "../lock.ts";
import { resolveRole } from "../registry/resolve.ts";
import type { Harness } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import type { WakePorts } from "../store/wake.ts";
import { coordinationEmit } from "./emit.ts";
import {
  type HealthEmit,
  MESSAGE_HEALTH_FIELDS,
  recordHealth,
  recordMessageHealth,
} from "./health.ts";
import { reconcileSlot } from "./reconcile.ts";
import { captureClaude, captureMessageSummary, captureMixed } from "./snapshot.ts";
import { type Json, locked, persist, snapshotPath } from "./store.ts";

const PRINTED = [
  "status",
  "previousStatus",
  "reason",
  "snapshot_id",
  "snapshot_path",
  "history_status",
  "worker_health_status",
  "question_state_status",
  "review_status",
  "review_reason",
  "recipient",
  "backlog_slots",
  "deferral_slots",
  "recipient_session_status",
  ...MESSAGE_HEALTH_FIELDS,
] as const;

function line(outcome: Readonly<Record<string, unknown>>): string {
  const printed: Record<string, unknown> = {};
  for (const key of PRINTED) {
    if (Object.hasOwn(outcome, key)) {
      printed[key] = outcome[key];
    }
  }
  return pyJsonDumps(printed);
}

/** A runner log line for a review the runner defers before any helper runs. */
export const DEFERRED_PREFIX = "bus: review deferred: ";

const PARENTS_INVALID =
  "worker parents must resolve through var/registry.json roles to distinct canonical UUIDs " +
  "in the active var/route.json";
const CONNECT_MS = 25_000;
const ROUTE_UNAVAILABLE =
  "review route is unavailable or invalid; its owner must verify identities and ownership";

/** A schema 1 route names its exact migration edit; any other invalid route the generic remedy. */
function routeUnavailable(error: RouteError): string {
  return error.message === ROUTE_SCHEMA_1 ? ROUTE_SCHEMA_1 : ROUTE_UNAVAILABLE;
}

function socketAvailable(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

/** Serializes calls: the connection matches one outstanding response at a time. */
class SerialClient implements RpcClient {
  readonly #client: RpcClient;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(client: RpcClient) {
    this.#client = client;
  }

  call(method: string, params: unknown): Promise<unknown> {
    const run = this.#tail.then(() => this.#client.call(method, params));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.#client.close();
  }
}

function unsupported(): never {
  throw new Error("snapshot adapter only reads inventory and collectors");
}

/** Inventory and collectors over one connection, or every capability unavailable without one. */
function snapshotAdapter(client: RpcClient | null, deadline: number): HarnessAdapter {
  return {
    ack: unsupported,
    collectors: {
      collect: (request) =>
        client === null
          ? Promise.resolve(unavailableCollected("collector_unavailable", request))
          : collectAll(client, deadline, request).catch(() =>
              unavailableCollected("collector_unavailable", request),
            ),
    },
    deliver: unsupported,
    harness: "codex",
    async inventory(conversationId: string): Promise<Inventory> {
      try {
        if (client === null) {
          throw new Error(SOCKET_MISSING);
        }
        const entries = await queueEntries(client, conversationId);
        return {
          entries: entries.map((entry) => ({
            clientUserMessageId: entry.clientUserMessageId,
            payload: queuePayload(entry),
            queueId: entry.id,
          })),
          status: "available",
        };
      } catch {
        return {
          entries: [],
          reason: "queue inventory unavailable or incomplete; retry snapshot before reconciliation",
          status: "unavailable",
        };
      }
    },
    status: unsupported,
  };
}

interface Wake {
  readonly layout: Layout;
  readonly capture: boolean;
  readonly claude: HarnessAdapter;
  readonly harnesses: Readonly<Record<string, Harness>>;
  readonly unblock: string;
  readonly busDir: string;
  /** The recipient's conversation. */
  readonly recipient: string;
  readonly peers: readonly string[];
  readonly parents: readonly string[];
  readonly slot: number;
  readonly socket: string;
  readonly emit: HealthEmit;
  readonly signal?: AbortSignal | undefined;
}

function capture(wake: Wake, client: RpcClient | null, deadline: number): Promise<Json> {
  const recipients = [...new Set([wake.recipient, ...wake.peers])];
  return locked(wake.unblock, async () => {
    const summary = captureMessageSummary(wake.layout);
    const snapshot = await captureMixed(
      {
        accountingLayout: wake.layout,
        busDir: wake.busDir,
        capture: wake.capture,
        messageSummary: summary,
        unblock: wake.unblock,
      },
      { claude: wake.claude, codex: snapshotAdapter(client, deadline) },
      wake.harnesses,
      recipients,
      wake.parents,
      { routeMembers: recipients, slot: wake.slot },
    );
    snapshot.message_health = recordMessageHealth(
      { unblock: wake.unblock },
      wake.recipient,
      wake.slot,
      summary,
    );
    persist(snapshotPath(wake.unblock, String(snapshot.snapshot_id)), snapshot);
    return snapshot;
  });
}

/** One slot under the non-blocking unblock lock, over one native connection. */
async function runSlot(wake: Wake): Promise<Json> {
  const { recipient, slot, unblock } = wake;
  const health = { emit: wake.emit, unblock };
  if (
    wake.parents.some((parent) => !isCanonicalUuid(parent)) ||
    new Set(wake.parents).size !== wake.parents.length
  ) {
    return { reason: PARENTS_INVALID, status: "deferred" };
  }
  mkdirSync(unblock, { recursive: true });
  const path = join(unblock, `${recipient}-${slot}.json`);
  let lock: LockHandle;
  try {
    lock = holdLock(join(unblock, "unblock.lock"), { nonBlocking: true });
  } catch (error) {
    if (error instanceof LockBusy) {
      return { status: "busy" };
    }
    throw error;
  }
  let client: RpcClient | null = null;
  let snapshot: Json | undefined;
  try {
    try {
      if (!socketAvailable(wake.socket)) {
        snapshot = await capture(wake, null, 0);
        const state: Json = { reason: SOCKET_MISSING, status: "deferred" };
        Object.assign(state, recordHealth(health, recipient, slot, snapshot, state));
        state.snapshot_path = snapshotPath(unblock, String(snapshot.snapshot_id));
        return state;
      }
      const deadline = performance.now() + CONNECT_MS;
      client = new SerialClient(await connectControl(deadline, wake.socket));
      // Stopping closes the connection so an unresolved send ends now, still `sending`.
      const open = client;
      wake.signal?.addEventListener("abort", () => open.close(), { once: true });
      // Inventory precedes decision guards and reminder deduplication.
      snapshot = await capture(wake, client, deadline);
      if (wake.signal?.aborted === true) {
        // A stop before any slot receipt write leaves the slot as it was.
        throw new SlotInterrupted();
      }
      const previous = previousSlot(path);
      let state: Json;
      let outcome: Json;
      if (previous === undefined) {
        state = await reconcileSlot(
          client,
          { recipient, signal: wake.signal, slot, unblock },
          snapshot,
        );
        outcome = state;
      } else {
        state = { previousStatus: previous.status, status: "deduplicated" };
        outcome = { ...state, reason: previous.reason ?? null };
      }
      Object.assign(state, recordHealth(health, recipient, slot, snapshot, outcome));
      state.snapshot_id = snapshot.snapshot_id;
      state.snapshot_path = snapshotPath(unblock, String(snapshot.snapshot_id));
      return state;
    } catch (error) {
      if (error instanceof SlotInterrupted) {
        throw error;
      }
      // Never log queue contents, native error messages or transport data.
      let state: Json;
      const stored = existsSync(path) ? readJson(path) : undefined;
      if (isRecord(stored)) {
        state = stored;
        if (state.status === "sending") {
          state.status = "ambiguous";
          state.reason = "send outcome unavailable; do not resend";
        }
      } else {
        state = { reason: "native metadata unavailable", slot, status: "blocked" };
      }
      persistSlot(path, state);
      snapshot ??= await capture(wake, null, 0);
      Object.assign(state, recordHealth(health, recipient, slot, snapshot, state));
      state.snapshot_path = snapshotPath(unblock, String(snapshot.snapshot_id));
      return state;
    }
  } finally {
    client?.close();
    lock.release();
  }
}

/** The Codex slot: socket and parent checks, then one budgeted connection for the whole slot. */
async function codexSlot(
  layout: Layout,
  game: GameLayout,
  scope: ActiveScope,
  parents: readonly string[],
  project: string,
  slot: number,
  signal: AbortSignal | undefined,
  capture: boolean,
): Promise<ReviewOutcome> {
  const socket = process.env.CODEX_CONTROL_SOCKET;
  if (socket === undefined || !isAbsolute(socket)) {
    return deferred("provide CODEX_CONTROL_SOCKET and the installed unblock helper");
  }
  const state = await runSlot({
    busDir: game.busDir,
    capture,
    claude: claudeAdapter(process.env, game),
    emit: coordinationEmit(layout, game, project),
    harnesses:
      scope.harnesses ??
      Object.fromEntries(
        [scope.recipient, ...scope.peers, ...parents].map((id) => [id, "codex" as const]),
      ),
    layout,
    parents,
    peers: scope.peers,
    recipient: scope.recipient,
    signal,
    slot,
    socket,
    unblock: unblockDir(game.busDir),
  });
  return { kind: "state", state };
}

/** Options for one scheduled review. */
export interface ReviewOptions {
  /** Automatic accounting capture at the review boundary; off unless set. */
  readonly capture?: boolean;
  /** Store mode: the environment and wake ports for the brief's wakes, and the store clock. */
  readonly env?: NodeJS.ProcessEnv;
  readonly wakePorts?: WakePorts;
  readonly now?: () => string;
}

/**
 * What one scheduled review did: no review for this game (`skip`), a deferral before any native
 * call (`deferred`, the runner's own deferral line), the slot status (`state`), or a stop while a
 * native send was unresolved (`interrupted`).
 */
export type ReviewOutcome =
  | { readonly kind: "skip"; readonly reason: "nothing-due" | "held"; readonly detail: string }
  | { readonly kind: "deferred"; readonly text: string }
  | { readonly kind: "state"; readonly state: Json }
  | { readonly kind: "interrupted" };

function deferred(text: string): ReviewOutcome {
  return { kind: "deferred", text };
}

function status(state: Json): ReviewOutcome {
  return { kind: "state", state };
}

/** The one-line runner form of an outcome: "" for no review, else a deferral or a JSON status. */
export function outcomeLine(outcome: ReviewOutcome): string {
  switch (outcome.kind) {
    case "deferred":
      return `${DEFERRED_PREFIX}${outcome.text}`;
    case "state":
      return line(outcome.state);
    default:
      return "";
  }
}

/**
 * Resolve the role-name route, its recipient and the worker parents through the registry as it is
 * now. A route this runner does not host, a held route or no route is skipped before any native
 * call.
 */
export async function reviewOutcome(
  layout: Layout,
  game: GameLayout,
  slot: number,
  signal?: AbortSignal,
  options: ReviewOptions = {},
): Promise<ReviewOutcome> {
  const capture = options.capture === true;
  try {
    let route: RoleRoute | null;
    try {
      route = readRoleRoute(layout);
    } catch (error) {
      if (error instanceof RouteError) {
        return deferred(routeUnavailable(error));
      }
      throw error;
    }
    if (route === null) {
      return { detail: "no review route", kind: "skip", reason: "nothing-due" };
    }
    if (route.host !== game.id) {
      return {
        detail: "this game does not host the review route",
        kind: "skip",
        reason: "nothing-due",
      };
    }
    let recipient: string;
    try {
      recipient = routeRecipient(layout, route);
    } catch (error) {
      if (error instanceof RouteError) {
        return deferred(routeUnavailable(error));
      }
      throw error;
    }
    const registry = readRegistry(layout);
    const send = sendRoute(registry, recipient, route, game.id);
    if (send.status !== "active") {
      return send.status === "held"
        ? { detail: "review route held", kind: "skip", reason: "held" }
        : {
            detail: "this game does not host the review route",
            kind: "skip",
            reason: "nothing-due",
          };
    }
    const scope = activeScope(send);
    if (scope === null) {
      return status({
        reason: "recipient has no conversation for the active harness",
        status: "deferred",
      });
    }
    const config = loadReportsConfig(game.configFile);
    const members = new Set([recipient, ...route.targets]);
    const parentRoles = config.reports.workerParents.map((role) => resolveRole(registry, role));
    if (parentRoles.some((role) => !members.has(role))) {
      // The Codex observer reports a scope deferral on its own line; the Claude helper as status.
      return send.harness === "codex"
        ? deferred("workerParents requires parents in the active review route")
        : status({
            reason: "worker parents must be in the active review route",
            status: "deferred",
          });
    }
    const parents = parentRoles.map((role) => roleConversation(registry, role));
    if (parents.some((parent) => parent === null)) {
      return status({
        reason: "worker parents require conversations for the active harness",
        status: "deferred",
      });
    }
    const unique = [...new Set(parents as string[])];
    if (send.harness === "codex") {
      return await codexSlot(
        layout,
        game,
        scope,
        unique,
        config.reports.project,
        slot,
        signal,
        capture,
      );
    }
    const unblock = unblockDir(game.busDir);
    const summary = captureMessageSummary(layout);
    const snapshot = await locked(unblock, async () => {
      const captured = captureClaude(
        { busDir: game.busDir, messageSummary: summary, slot, unblock },
        null,
        scope,
        scope.recipient,
        unique,
      );
      captured.accounting = await boundaryAccounting(capture, layout, captured);
      captured.message_health = recordMessageHealth({ unblock }, scope.recipient, slot, summary);
      persist(snapshotPath(unblock, String(captured.snapshot_id)), captured);
      return captured;
    });
    const snapshotFile = snapshotPath(unblock, String(snapshot.snapshot_id));
    const diagnostics = [
      {
        detail:
          messageReview({ health: snapshot.message_health, snapshotPath: snapshotFile }, summary) +
          accountingReview(snapshot.accounting),
        kind: "durable_messages",
        snapshot_path: snapshotFile,
        status: summary.status,
      },
    ];
    if (signal?.aborted === true) {
      // A stop before the slot receipt is written leaves the slot as it was.
      return { kind: "interrupted" };
    }
    const state = spoolReviewBrief(process.env, game.busDir, scope, slot, unique, diagnostics);
    if (state.status === "busy" || state.status === "deduplicated") {
      return status({ ...state });
    }
    return status({
      ...state,
      ...(snapshot.message_health as Json),
      snapshot_id: snapshot.snapshot_id,
      snapshot_path: snapshotFile,
    });
  } catch (error) {
    if (error instanceof SlotInterrupted) {
      return { kind: "interrupted" };
    }
    return status({ reason: "review route or state unavailable", status: "blocked" });
  }
}

/**
 * The runner's form of `reviewOutcome`: "" when this runner does not dispatch the slot (or stopped
 * during a native send), a `DEFERRED_PREFIX` line, or the slot's one-line JSON status.
 */
export async function deliverScheduledReview(
  layout: Layout,
  game: GameLayout,
  slot: number,
  signal?: AbortSignal,
  options: ReviewOptions = {},
): Promise<string> {
  return outcomeLine(await reviewOutcome(layout, game, slot, signal, options));
}
