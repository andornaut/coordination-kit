// A durable send may wake its recipient using only the inbox command. One adapter per harness
// delivers the wake to the role's current binding: Claude through the role's wake file, which its
// channel announces, and Codex through one guarded control-socket queue add.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { wakeText, writeWakeFile } from "../adapters/claude/wakeFile.ts";
import { queueEntries, type QueueEntry, QueueInventoryError } from "../adapters/codex/inventory.ts";
import {
  codexQueueTransport,
  inputUnavailable,
  type QueueClearance,
  type TransportReceipt,
} from "../adapters/codex/queue.ts";
import { connectControl, NativeTimeout, type RpcClient, RpcError } from "../adapters/codex/rpc.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import type { Layout } from "../core/layout.ts";
import { isRecord } from "../core/pyjson.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Harness } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { type Store, storeRoot } from "./db.ts";
import { coalescedMessages } from "./messageWake.ts";
import { blockerPayload, safeWakeBlocker, safeWakeReason } from "./projections/messageWake.ts";
import { questionHoldGuard } from "./questions.ts";
import {
  type Actor,
  StoreError,
  type WakeBlocker,
  type WakeGuard,
  type WakeOutcome,
} from "./types.ts";

/**
 * The store question and hold check, run after the registry checks. The default,
 * `questionHoldGuard`, blocks pending questions, recipient role holds and scoped policy holds.
 */
export type StoreWakeGuard = (store: Store, role: string, harness?: Harness | null) => WakeGuard;

/** A guard that passes every recipient, for callers that check questions and holds themselves. */
export const NO_STORE_GUARD: StoreWakeGuard = () => ({ status: "clear" });

export interface WakePorts {
  /** The Codex control connection; defaults to the resolved control socket. */
  readonly connect?: () => Promise<RpcClient>;
  /** Defaults to `questionHoldGuard`. */
  readonly storeGuard?: StoreWakeGuard;
}

export interface WakeContext {
  readonly layout: Layout;
  readonly env: NodeJS.ProcessEnv;
  readonly store: Store;
  readonly ports?: WakePorts;
}

export type WakeStatus = WakeOutcome | "coalesced" | "none";

export interface WakeResult {
  readonly status: WakeStatus;
  readonly wake?: string;
  readonly reason?: string;
}

interface Target {
  readonly harness: Harness;
  readonly conversation: string;
}

interface WakeClaim {
  readonly count: number;
  readonly target: Target;
}

interface Delivery {
  readonly outcome: WakeOutcome;
  readonly detail: string | null;
  readonly blocker: WakeBlocker | null;
}

/** Delivers one claimed wake to the role's current binding on one harness. */
type WakeAdapter = (
  context: WakeContext,
  role: string,
  target: Target,
  wake: { readonly id: string; readonly count: number },
) => Promise<Delivery>;

/** The recipient's current binding, or the registry reason no wake may go to it. */
function wakeTarget(
  layout: Layout,
  role: string,
): Target | { readonly reason: string; readonly harness: Harness | null } {
  try {
    const registry = readRegistry(layout);
    const record = registry.roles[role];
    if (record === undefined) {
      return { harness: null, reason: "recipient-unregistered" };
    }
    const harness = resolveHarness(registry, role);
    if (
      record.ownership !== "active" ||
      record.phase === "held" ||
      record.phase === "source-held"
    ) {
      return { harness, reason: "recipient-held" };
    }
    const conversation = resolveConversation(registry, role);
    return conversation === null
      ? { harness, reason: "recipient-unbound" }
      : { conversation, harness };
  } catch {
    return { harness: null, reason: "registry-unavailable" };
  }
}

function sameTarget(layout: Layout, role: string, target: Target): boolean {
  const current = wakeTarget(layout, role);
  return (
    "conversation" in current &&
    current.conversation === target.conversation &&
    current.harness === target.harness
  );
}

function checkStoreGuard(context: WakeContext, role: string, harness: Harness): WakeGuard {
  return (context.ports?.storeGuard ?? questionHoldGuard)(context.store, role, harness);
}

const SYSTEM: Actor = { nativeId: null, role: null };

function undeliveredIds(store: Store, role: string): string[] {
  return (
    store.db
      .prepare("SELECT id FROM messages WHERE to_role = ? AND state = 'sent' ORDER BY sent_seq")
      .all(role) as { id: string }[]
  ).map(({ id }) => id);
}

/** One recipient's wake state: pending since a send, and the outstanding wake if any. */
export function wakeState(
  store: Store,
  role: string,
): { readonly pending: boolean; readonly outstanding: string | null } {
  const row = store.db
    .prepare("SELECT pending, outstanding FROM wake_state WHERE role = ?")
    .get(role) as { pending: number; outstanding: string | null } | undefined;
  return { outstanding: row?.outstanding ?? null, pending: Number(row?.pending ?? 0) === 1 };
}

/** Recipients with unread originals since their last pull. A review seam read. */
export function pendingWakeRoles(store: Store): string[] {
  return (
    store.db
      .prepare(
        `SELECT w.role FROM wake_state w WHERE w.pending = 1 AND EXISTS
           (SELECT 1 FROM messages m WHERE m.to_role = w.role AND m.state = 'sent')
         ORDER BY w.role`,
      )
      .all() as { role: string }[]
  ).map((row) => row.role);
}

/**
 * Clear a recipient's outstanding wake so the next `wakeRecipient` may send one again. Only the
 * scheduled review calls this. A planned attempt is reserved before native I/O, even if there
 * is nothing to clear. It never rearms a newer outstanding wake or reserves the same key twice.
 */
export function rearmWake(
  store: Store,
  actor: Actor,
  role: string,
  reason: string,
  attempt?: { readonly key: string; readonly outstanding: string | null },
): boolean {
  return store.transaction(() => {
    const { outstanding } = wakeState(store, role);
    if (
      attempt === undefined
        ? outstanding === null
        : outstanding !== null && outstanding !== attempt.outstanding
    ) {
      return false;
    }
    const { duplicate } = store.append({
      actor,
      key: attempt?.key ?? `wake.rearmed:${role}:${store.head().seq}`,
      kind: "wake.rearmed",
      payload: { reason, role },
    });
    return !duplicate;
  });
}

function outstandingWake(store: Store, role: string, target: Target | null) {
  const id = wakeState(store, role).outstanding;
  if (id === null) {
    return null;
  }
  const current = store.db
    .prepare("SELECT id, seq, conversation, harness FROM wakes WHERE id = ? AND role = ?")
    .get(id, role) as
    { id: string; seq: number; conversation: string; harness: Harness } | undefined;
  return current !== undefined &&
    (target === null ||
      (current.harness === target.harness && current.conversation === target.conversation))
    ? current
    : null;
}

const claudeWake: WakeAdapter = (context, role, target, wake) => {
  const guard = checkStoreGuard(context, role, target.harness);
  if (guard.status !== "clear") {
    return Promise.resolve({
      blocker: safeWakeBlocker(guard.blocker, role),
      detail: safeWakeReason(guard.reason, "store-guard"),
      outcome: "guarded",
    });
  }
  writeWakeFile(context.layout, { count: wake.count, role });
  return Promise.resolve({ blocker: null, detail: null, outcome: "accepted" });
};

function codexOutcome(receipt: TransportReceipt): WakeOutcome {
  switch (receipt.status) {
    case "accepted":
      return "accepted";
    case "blocked":
      return "guarded";
    case "ambiguous":
    case "queued":
      return "ambiguous";
    default:
      return "failed";
  }
}

function wakeConnection(context: WakeContext): Promise<RpcClient> {
  return (
    context.ports?.connect?.() ??
    connectControl(performance.now() + 15_000, resolveCodexControlSocket({ env: context.env }).path)
  );
}

const QUEUED_WAKE = /^\d+ new messages for ([^ :]+): run coordination-kit inbox$/;

function queuedWake(entry: QueueEntry, role: string): boolean {
  return entry.input.some(
    (item) =>
      isRecord(item) &&
      item.type === "text" &&
      typeof item.text === "string" &&
      QUEUED_WAKE.exec(item.text)?.[1] === role,
  );
}

/** A matching notice and proof unavailable both withhold a new wake for different reasons. */
async function noticeQueueGuard(
  client: RpcClient,
  recipient: string,
  role: string,
): Promise<WakeGuard> {
  try {
    const entries = await queueEntries(client, recipient, 10);
    const queued = entries.some((entry) => queuedWake(entry, role));
    return queued
      ? { reason: "native-notice-already-queued", status: "blocked" }
      : { status: "clear" };
  } catch (error) {
    const reason =
      error instanceof QueueInventoryError
        ? error.reason
        : error instanceof NativeTimeout
          ? "timeout"
          : error instanceof RpcError
            ? "refused"
            : "unverified";
    return { reason: `native-notice-queue-${reason}`, status: "blocked" };
  }
}

const codexWake: WakeAdapter = async (context, role, target, wake) => {
  const { layout } = context;
  const recipient = target.conversation;
  let refused: WakeGuard | undefined;
  const locallyClear = (): boolean => {
    if (!sameTarget(layout, role, target)) {
      refused = {
        blocker: { id: role, kind: "registry", owner: role },
        reason: "recipient-binding-changed",
        status: "blocked",
      };
      return false;
    }
    const guard = checkStoreGuard(context, role, target.harness);
    refused = guard.status === "blocked" ? guard : undefined;
    return refused === undefined;
  };
  const transport = codexQueueTransport({
    canConnect: locallyClear,
    connect: () => wakeConnection(context),
    guards: {
      beforeAdd: async (client): Promise<QueueClearance> => {
        if (!locallyClear()) {
          return { status: "blocked" };
        }
        const diagnostic = await inputUnavailable(client, recipient);
        if (diagnostic !== null) {
          return { diagnostic, status: "blocked" };
        }
        const queue = await noticeQueueGuard(client, recipient, role);
        if (queue.status === "blocked") {
          refused = queue;
          return { status: "blocked" };
        }
        return { status: locallyClear() ? "clear" : "blocked" };
      },
    },
  });
  const receipt = await transport.send(
    join(storeRoot(layout), "wake", "codex", `${wake.id}.json`),
    {
      recipient,
      requestId: wake.id,
      text: wakeText({ count: wake.count, role, seq: 1 }),
    },
  );
  const outcome = codexOutcome(receipt);
  return {
    blocker: safeWakeBlocker(refused?.blocker, role),
    detail:
      outcome === "accepted"
        ? null
        : safeWakeReason(
            refused?.reason ?? receipt.diagnostic?.category,
            `transport-${receipt.status}`,
          ),
    outcome,
  };
};

const ADAPTERS: Readonly<Record<Harness, WakeAdapter>> = { claude: claudeWake, codex: codexWake };

/**
 * Attempt at most one wake for `role`, after the caller's send has committed. Nothing is sent
 * when no messages need a wake, when a prior wake for the same binding remains outstanding, or
 * when a guard refuses the operation.
 */
export async function wakeRecipient(context: WakeContext, role: string): Promise<WakeResult> {
  const { store } = context;
  const wake = randomUUID();
  const claim = store.transaction<WakeResult | WakeClaim>(() => {
    const target = wakeTarget(context.layout, role);
    const state = wakeState(store, role);
    const messages = undeliveredIds(store, role);
    const count = messages.length;
    if (!state.pending || count === 0) {
      return { status: "none" };
    }
    const outstanding = outstandingWake(store, role, "conversation" in target ? target : null);
    if (outstanding !== null) {
      const later = coalescedMessages(store, role, outstanding.id, outstanding.seq);
      const last = later.at(-1);
      if (last !== undefined) {
        store.append({
          actor: SYSTEM,
          key: `wake.coalesced:${outstanding.id}:${last}`,
          kind: "wake.coalesced",
          payload: { messages: later, role, wake: outstanding.id },
        });
      }
      return { status: "coalesced", wake: outstanding.id };
    }
    const guard: WakeGuard =
      "reason" in target
        ? {
            blocker: { id: role, kind: "registry", owner: role },
            reason: target.reason,
            status: "blocked",
          }
        : checkStoreGuard(context, role, target.harness);
    if (guard.status !== "clear" || "reason" in target) {
      const reason = safeWakeReason(guard.reason, "store-guard");
      store.append({
        actor: SYSTEM,
        key: `wake.guarded:${wake}`,
        kind: "wake.guarded",
        payload: {
          blocker: blockerPayload(safeWakeBlocker(guard.blocker, role)),
          count,
          harness: target.harness,
          messages,
          reason,
          role,
          wake,
        },
      });
      return { reason, status: "guarded", wake };
    }
    store.append({
      actor: SYSTEM,
      key: `wake.claimed:${wake}`,
      kind: "wake.claimed",
      payload: {
        conversation: target.conversation,
        count,
        harness: target.harness,
        messages,
        role,
        wake,
      },
    });
    return { count, target };
  });
  if ("status" in claim) {
    return claim;
  }
  const { target } = claim;
  let delivery: Delivery;
  try {
    delivery = await ADAPTERS[target.harness](context, role, target, {
      count: claim.count,
      id: wake,
    });
  } catch (error) {
    delivery = {
      blocker: null,
      detail: safeWakeReason(error instanceof StoreError ? error.code : null, "wake-error"),
      outcome: target.harness === "claude" ? "failed" : "ambiguous",
    };
  }
  store.append({
    actor: SYSTEM,
    key: `wake.completed:${wake}`,
    kind: "wake.completed",
    payload: {
      blocker: blockerPayload(delivery.blocker),
      detail: delivery.detail,
      outcome: delivery.outcome,
      role,
      wake,
    },
  });
  return { status: delivery.outcome, wake };
}
