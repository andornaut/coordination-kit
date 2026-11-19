// Bus event outbox: durable enqueue with sha256(kind:key) dedupe and bounded delivery.
//
// recordEvent records an event once under events/state.lock; a producer may derive further state
// under the same lock (delivery-kit tracks per-SHA CI and deployment state there). flushEvents
// delivers unsent events in creation order under the non-blocking dispatch.lock, through the
// recipient's selected adapter, and marks an event sent only after its delivery is accepted. The
// first event not accepted stops the flush; a later flush resumes there. Each flush returns a
// typed result: its status, a reason token, and how many events it delivered and left unsent.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { claudeAdapter } from "./adapters/claude/index.ts";
import { codexAdapter, type ReceiptSeed } from "./adapters/codex/index.ts";
import { eventRequestId, isCanonicalUuid } from "./adapters/shared/ids.ts";
import { dumpsJson, isRecord, type PyJson } from "./adapters/shared/pyjson.ts";
import { readRoleRoute, routeRecipient } from "./adapters/shared/route.ts";
import type { DeliveryReceipt, HarnessAdapter } from "./adapters/types.ts";
import { loadReportsConfig } from "./config.ts";
import { readJson, writeDurable } from "./durable.ts";
import { type GameLayout, type Layout, loadLayout } from "./layout.ts";
import { holdLock, LockBusy, type LockHandle } from "./lock.ts";
import { resolveConversation, resolveHarness, resolveRole } from "./registry/resolve.ts";
import type { Harness } from "./registry/schema.ts";
import { readRegistry } from "./registry/store.ts";
import { type ReasonToken, reasonToken, type SeamStatus } from "./review/outcome.ts";

export interface EmitOptions {
  readonly project: string;
  /** Runs under events/state.lock after the enqueue, for state the producer derives. */
  readonly underLock?: ((directory: string) => void) | undefined;
}

/** Progress kinds that never notify; flush marks any already queued as suppressed. */
export const QUIET_KINDS: ReadonlySet<string> = new Set([
  "ci_pending",
  "ci_running",
  "deploy_pending",
  "deploy_retry",
  "gate_passed",
  "gate_skipped",
]);

/** Delivered text, suffix included, stays within this many UTF-8 bytes. */
export const DELIVERY_BUDGET = 900;
const CLEAN_LIMIT = 1800;

export interface BusEvent {
  [key: string]: PyJson | undefined;
  created: bigint;
  id: string;
  kind: string;
  key: string;
  message: string;
  sent: boolean;
  suppressed?: boolean;
}

export function eventsDir(game: GameLayout): string {
  return join(game.busDir, "events");
}

/** Every blocked-* kind shares one identity, so a changed block reason does not repeat. */
export function eventId(kind: string, key: string): string {
  const identityKind = kind.startsWith("blocked-") ? "blocked" : kind;
  return createHash("sha256").update(`${identityKind}:${key}`, "utf8").digest("hex");
}

/** Control characters become spaces; at most 1800 code points are kept. */
export function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return Array.from(value.replace(/[\x00-\x1f\x7f]/g, " "))
    .slice(0, CLEAN_LIMIT)
    .join("");
}

/** The message cut to the byte budget at a character boundary, then the event ID suffix. */
export function deliveryMessage(event: Pick<BusEvent, "id" | "message">): string {
  const suffix = ` [bus event ${event.id.slice(0, 12)}]`;
  const budget = DELIVERY_BUDGET - Buffer.byteLength(suffix, "utf8");
  const body = Buffer.from(event.message, "utf8");
  let end = Math.min(budget, body.length);
  // A cut inside a multi-byte sequence drops the partial character.
  while (end > 0 && end < body.length && ((body[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${body.subarray(0, end).toString("utf8")}${suffix}`;
}

// Wall-clock nanoseconds like time.time_ns(), but monotonic within this process so events
// emitted in sequence keep their order.
const EPOCH_OFFSET = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

function nowNanoseconds(): bigint {
  return EPOCH_OFFSET + process.hrtime.bigint();
}

/** Replace one outbox file durably, in the outbox's JSON form. */
export function writeEventState(path: string, value: PyJson): void {
  writeDurable(path, `${dumpsJson(value)}\n`);
}

/** Enqueue one event unless it is quiet or already recorded. The caller holds state.lock. */
export function enqueueEvent(
  directory: string,
  project: string,
  kind: string,
  key: string,
  message: string,
): void {
  if (QUIET_KINDS.has(kind)) {
    return;
  }
  const id = eventId(kind, key);
  const path = join(directory, `${id}.json`);
  if (existsSync(path)) {
    return;
  }
  const event: BusEvent = {
    created: nowNanoseconds(),
    id,
    key: clean(key),
    kind,
    message: clean(`${project} bus: ${message}`),
    sent: false,
  };
  writeEventState(path, event);
}

/** Record one event, at most once per identity, then run the producer's `underLock` step. */
export function recordEvent(
  game: GameLayout,
  options: EmitOptions,
  kind: string,
  key: string,
  message: string,
): void {
  const directory = eventsDir(game);
  mkdirSync(directory, { recursive: true });
  const lock = holdLock(join(directory, "state.lock"));
  try {
    enqueueEvent(directory, options.project, kind, key, message);
    options.underLock?.(directory);
  } finally {
    lock.release();
  }
}

/** Read an event, keeping its nanosecond `created` exact rather than as a float. */
function readEvent(path: string): BusEvent {
  const text = readFileSync(path, "utf8");
  const event = JSON.parse(text) as BusEvent;
  const created = /"created":\s*(-?\d+)\b/.exec(text)?.[1];
  event.created =
    created === undefined ? BigInt(Math.trunc(Number(event.created))) : BigInt(created);
  return event;
}

function pendingEvents(directory: string): BusEvent[] | null {
  const events: BusEvent[] = [];
  for (const name of readdirSync(directory)) {
    if (name.startsWith(".") || !name.endsWith(".json")) {
      continue;
    }
    try {
      events.push(readEvent(join(directory, name)));
    } catch {
      // One unreadable event stops the whole flush.
      return null;
    }
  }
  // Stable: equal creation times keep directory order.
  return events.sort((left, right) => {
    if (left.created === right.created) {
      return 0;
    }
    return left.created < right.created ? -1 : 1;
  });
}

/** A harness adapter whose deliver may also bind extra receipt fields. */
export interface EventAdapter extends HarnessAdapter {
  deliver(
    receiptPath: string,
    requestId: string,
    conversationId: string,
    text: string,
    seed?: ReceiptSeed,
  ): Promise<DeliveryReceipt>;
}

export type AdapterFactory = (layout: Layout, game: GameLayout) => EventAdapter;
export type AdapterFactories = Readonly<Partial<Record<Harness, AdapterFactory>>>;

/** The adapter per harness. A harness without one defers delivery. */
const DEFAULT_ADAPTERS: AdapterFactories = {
  // The Claude adapter takes the event ID from the receipt file name and ignores the seed.
  claude: (_layout, game) => claudeAdapter(process.env, game),
  codex: (layout) => codexAdapter(layout),
};

/** The lock when free; null when another flush holds it. */
function tryLock(path: string): LockHandle | null {
  try {
    return holdLock(path, { nonBlocking: true });
  } catch (error) {
    if (error instanceof LockBusy) {
      return null;
    }
    throw error;
  }
}

/** var/games/<g>/ is three levels below the game-coordinator root. */
function coordinatorRoot(game: GameLayout): string {
  return resolve(game.stateDir, "..", "..", "..");
}

/**
 * Event routing by role. Events go only to the registry recipient through the active adapter,
 * with no queue fallback. An invalid route, or a held one whose recipient is this recipient,
 * defers every event; any other recipient, or no route at all, is delivered.
 */
function eventRouting(layout: Layout, recipientRole: string): "deliver" | "held" | "invalid" {
  try {
    const route = readRoleRoute(layout);
    if (route === null) {
      return "deliver";
    }
    return routeRecipient(layout, route) === recipientRole && route.state === "held"
      ? "held"
      : "deliver";
  } catch {
    return "invalid";
  }
}

interface Destination {
  readonly adapter: EventAdapter;
  readonly harness: Harness;
  readonly recipient: string;
}

/** Why no destination resolved. */
interface Undeliverable {
  readonly reason: ReasonToken;
  readonly detail: string;
}

function destination(adapters: AdapterFactories, game: GameLayout): Destination | Undeliverable {
  try {
    const layout = loadLayout(coordinatorRoot(game));
    const registry = readRegistry(layout);
    const role = loadReportsConfig(game.configFile).reports.recipient;
    const recipient = resolveConversation(registry, role);
    const harness = resolveHarness(registry, role);
    const factory = adapters[harness];
    if (recipient === null || factory === undefined) {
      return {
        detail: "the recipient has no conversation or adapter for its harness",
        reason: "recipient-unavailable",
      };
    }
    const routing = eventRouting(layout, resolveRole(registry, role));
    if (routing === "held") {
      return { detail: "the review route is held for this recipient", reason: "held" };
    }
    if (routing === "invalid") {
      return { detail: "review route is unavailable or invalid", reason: "route-unavailable" };
    }
    return { adapter: factory(layout, game), harness, recipient };
  } catch {
    // An unresolvable recipient leaves every event unsent for a later flush.
    return { detail: "the recipient does not resolve", reason: "recipient-unavailable" };
  }
}

function undeliverable(value: Destination | Undeliverable): value is Undeliverable {
  return Object.hasOwn(value, "reason");
}

const STORED_EVENT_STATUSES: ReadonlySet<string> = new Set([
  "accepted",
  "ambiguous",
  "deferred",
  "rejected",
  "sending",
]);
const STORED_EVENT_METHODS: ReadonlySet<string> = new Set([
  "claude-channel",
  "turn/start",
  "turn/steer",
]);

/** Retargeting never retries a native send whose outcome is still unknown. */
function previousDelivery(
  directory: string,
  target: Destination,
  event: BusEvent,
): "accepted" | "blocked" | "none" {
  let accepted = false;
  let blocked = false;
  try {
    const names = readdirSync(directory).filter(
      (name) => name.startsWith(`${event.id}-`) && name.endsWith(".json"),
    );
    for (const name of names) {
      const value = readJson(join(directory, name));
      if (
        !isRecord(value) ||
        !isCanonicalUuid(value.recipient) ||
        name !== `${event.id}-${value.recipient}.json` ||
        value.event_id !== event.id ||
        value.clientUserMessageId !== eventRequestId(event.id, value.recipient) ||
        !Array.isArray(value.attempts) ||
        typeof value.status !== "string" ||
        !STORED_EVENT_STATUSES.has(value.status) ||
        value.attempts.some(
          (attempt) =>
            !isRecord(attempt) ||
            typeof attempt.method !== "string" ||
            !STORED_EVENT_METHODS.has(attempt.method) ||
            typeof attempt.status !== "string" ||
            attempt.status === "deferred" ||
            !STORED_EVENT_STATUSES.has(attempt.status),
        )
      ) {
        return "blocked";
      }
      if (value.status === "accepted") {
        accepted = true;
      }
      if (["sending", "ambiguous", "rejected"].includes(value.status)) {
        const methods = value.attempts.map((attempt) =>
          isRecord(attempt) ? attempt.method : null,
        );
        const otherProvider = methods.some((method) =>
          target.harness === "codex"
            ? method !== "turn/start" && method !== "turn/steer"
            : method !== "claude-channel",
        );
        blocked ||= value.recipient !== target.recipient || otherProvider;
      }
    }
  } catch {
    return "blocked";
  }
  return accepted ? "accepted" : blocked ? "blocked" : "none";
}

/** What one flush did. `delivered` counts events marked sent; `held`, events left unsent. */
export interface FlushResult {
  readonly status: SeamStatus;
  readonly reason: ReasonToken | null;
  readonly detail: string;
  readonly delivered: number;
  readonly held: number;
}

/** Unsent events left in the outbox; an unreadable event file counts as unsent. */
function heldCount(directory: string): number {
  let held = 0;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) {
      continue;
    }
    try {
      const event = readEvent(join(directory, name));
      if (!event.sent && event.suppressed !== true && !QUIET_KINDS.has(event.kind)) {
        held += 1;
      }
    } catch {
      held += 1;
    }
  }
  return held;
}

/** Deliver unsent events through `adapters`; the testable form of flushEvents. */
export async function flushEventsWith(
  adapters: AdapterFactories,
  game: GameLayout,
): Promise<FlushResult> {
  const directory = eventsDir(game);
  let delivered = 0;
  const finish = (reason: ReasonToken | null, detail: string): FlushResult => {
    const held = heldCount(directory);
    if (held === 0) {
      return delivered > 0
        ? { delivered, detail: `delivered ${delivered}`, held, reason: null, status: "delivered" }
        : { delivered, detail: "no unsent events", held, reason: "no-events", status: "skipped" };
    }
    return { delivered, detail, held, reason: reason ?? "recipient-busy", status: "deferred" };
  };
  if (!existsSync(directory)) {
    return {
      delivered,
      detail: "no event outbox",
      held: 0,
      reason: "no-events",
      status: "skipped",
    };
  }
  const lock = tryLock(join(directory, "dispatch.lock"));
  if (lock === null) {
    return finish("recipient-busy", "another flush holds dispatch.lock");
  }
  try {
    const first = destination(adapters, game);
    if (undeliverable(first)) {
      return finish(first.reason, first.detail);
    }
    const events = pendingEvents(directory);
    if (events === null) {
      return finish("outbox-unreadable", "an event file is unreadable");
    }
    const receipts = join(directory, "native");
    mkdirSync(receipts, { recursive: true });
    for (const event of events) {
      if (event.suppressed === true || event.sent) {
        continue;
      }
      const path = join(directory, `${event.id}.json`);
      if (QUIET_KINDS.has(event.kind)) {
        event.suppressed = true;
        writeEventState(path, event);
        continue;
      }
      const target = destination(adapters, game);
      if (undeliverable(target)) {
        return finish(target.reason, target.detail);
      }
      const previous = previousDelivery(receipts, target, event);
      if (previous === "blocked") {
        // The flush runs in delivery-kit's resident runner, whose stderr names that kit.
        process.stderr.write(
          `delivery-kit: event ${event.id} held: reconcile prior native receipt before retargeting\n`,
        );
        return finish(
          "receipt-ambiguous",
          `event ${event.id} held: reconcile prior native receipt before retargeting`,
        );
      }
      if (previous === "accepted") {
        event.sent = true;
        writeEventState(path, event);
        delivered += 1;
        continue;
      }
      const requestId = eventRequestId(event.id, target.recipient);
      // Events deliver one at a time in creation order and stop at the first refusal.
      // eslint-disable-next-line no-await-in-loop
      const receipt = await target.adapter.deliver(
        join(receipts, `${event.id}-${target.recipient}.json`),
        requestId,
        target.recipient,
        deliveryMessage(event),
        { event_id: event.id },
      );
      if (receipt.status !== "accepted") {
        const why = receipt.reason === undefined ? "" : `: ${receipt.reason}`;
        return finish(
          reasonToken(receipt.status, receipt.reason),
          `event ${event.id.slice(0, 12)} ${receipt.status}${why}`,
        );
      }
      event.sent = true;
      writeEventState(path, event);
      delivered += 1;
    }
    return finish(null, "events recorded during this flush remain unsent");
  } finally {
    lock.release();
  }
}

export function flushEvents(game: GameLayout): Promise<FlushResult> {
  return flushEventsWith(DEFAULT_ADAPTERS, game);
}
