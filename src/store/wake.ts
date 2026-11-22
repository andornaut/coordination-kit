// Wakes: after a send commits, the recipient is wake-pending and at most one wake is outstanding
// per recipient. A wake carries no payload, only the fixed text `N new messages for ROLE: run
// coordination-kit inbox`. Claude gets its per-conversation wake file; Codex gets one guarded
// control-socket queue add. Outcomes are logged in `wakes` and never change message state. A
// failed or ambiguous wake stays outstanding until the recipient's next pull or a review rearms it.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { wakeText, writeWakeFile } from "../adapters/claude/wakeFile.ts";
import { clearanceUnchanged } from "../adapters/codex/guard.ts";
import {
  codexQueueTransport,
  type QueueClearance,
  type TransportReceipt,
} from "../adapters/codex/queue.ts";
import { connectControl, type RpcClient } from "../adapters/codex/rpc.ts";
import { selectTarget } from "../adapters/codex/steer.ts";
import { decisionClear, decisionDirectory, decisionRecord } from "../adapters/shared/decisions.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import type { Layout } from "../layout.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Harness } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { type Store, storeRoot } from "./db.ts";
import {
  blockerPayload,
  coalescedMessages,
  safeWakeBlocker,
  safeWakeReason,
} from "./messageWake.ts";
import { questionHoldGuard } from "./questions.ts";
import { type Actor, StoreError, type WakeBlocker, type WakeOutcome } from "./types.ts";

export interface WakeGuard {
  readonly status: "clear" | "blocked";
  readonly reason?: string;
  readonly blocker?: WakeBlocker;
}

/**
 * The store question and hold check, run after the registry checks. The default,
 * `questionHoldGuard`, blocks pending questions, recipient role holds and scoped policy holds.
 * The Codex native question check still runs after it.
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

/** Recipients that are wake-pending with undelivered messages. A review seam read. */
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
 * scheduled review calls this, after its slot boundary; it never touches message state.
 */
export function rearmWake(store: Store, actor: Actor, role: string, reason: string): boolean {
  return store.transaction(() => {
    const outstanding = wakeState(store, role).outstanding;
    if (outstanding === null) {
      return false;
    }
    const receipt = store.db
      .prepare("SELECT harness, outcome FROM wakes WHERE id = ? AND role = ?")
      .get(outstanding, role);
    if (receipt === undefined || (receipt.harness !== "claude" && receipt.outcome !== "failed")) {
      return false;
    }
    store.append({
      actor,
      key: `wake.rearmed:${role}:${store.head().seq}`,
      kind: "wake.rearmed",
      payload: { reason, role },
    });
    return true;
  });
}

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

async function codexWake(
  context: WakeContext,
  role: string,
  target: Target,
  wake: string,
  text: string,
): Promise<{
  readonly outcome: WakeOutcome;
  readonly detail: string | null;
  readonly blocker: WakeBlocker | null;
}> {
  const { layout } = context;
  const recipient = target.conversation;
  let refused: WakeGuard | undefined;
  const locallyClear = (): boolean => {
    const directory = decisionDirectory(layout, role);
    if (!sameTarget(layout, role, target)) {
      refused = {
        blocker: { id: role, kind: "registry", owner: role },
        reason: "recipient-binding-changed",
        status: "blocked",
      };
      return false;
    }
    const guard = checkStoreGuard(context, role, target.harness);
    if (guard.status === "blocked") {
      refused = guard;
      return false;
    }
    if (directory === null || !decisionClear(directory, recipient)) {
      refused = { reason: "decision-clearance", status: "blocked" };
      return false;
    }
    refused = undefined;
    return true;
  };
  const transport = codexQueueTransport({
    canConnect: locallyClear,
    connect:
      context.ports?.connect ??
      (() =>
        connectControl(
          performance.now() + 15_000,
          resolveCodexControlSocket({ env: context.env }).path,
        )),
    guards: {
      beforeAdd: async (client): Promise<QueueClearance> => {
        const directory = decisionDirectory(layout, role);
        if (directory === null || !locallyClear()) {
          return { status: "blocked" };
        }
        const marker = decisionRecord(directory, recipient);
        const [selected, , diagnostic] = await selectTarget(client, directory, recipient);
        return {
          ...(diagnostic === undefined ? {} : { diagnostic }),
          status:
            selected !== null && clearanceUnchanged(directory, recipient, marker) && locallyClear()
              ? "clear"
              : "blocked",
        };
      },
    },
  });
  const receipt = await transport.send(join(storeRoot(layout), "wake", "codex", `${wake}.json`), {
    recipient,
    requestId: wake,
    text,
  });
  const outcome = codexOutcome(receipt);
  const native =
    receipt.diagnostic && "question" in receipt.diagnostic
      ? receipt.diagnostic.question
      : undefined;
  const blocker =
    safeWakeBlocker(refused?.blocker, role) ??
    (native === undefined
      ? null
      : safeWakeBlocker({ id: wake, kind: "native-question", native, owner: role }, role));
  return {
    blocker,
    detail:
      outcome === "accepted"
        ? null
        : safeWakeReason(
            refused?.reason ?? receipt.diagnostic?.category,
            `transport-${receipt.status}`,
          ),
    outcome,
  };
}

/**
 * Attempt at most one wake for `role`, after the caller's send has committed. Nothing is sent
 * when the recipient is not wake-pending, has nothing undelivered or already has an outstanding
 * wake. A guard refusal is logged as `guarded` and leaves nothing outstanding.
 */
export async function wakeRecipient(context: WakeContext, role: string): Promise<WakeResult> {
  const { store } = context;
  const target = wakeTarget(context.layout, role);
  const wake = randomUUID();
  const claim = store.transaction((): WakeResult | { readonly count: number } => {
    const state = wakeState(store, role);
    const messages = undeliveredIds(store, role);
    const count = messages.length;
    if (!state.pending || count === 0) {
      return { status: "none" };
    }
    if (state.outstanding !== null) {
      const outstanding = state.outstanding;
      const later = coalescedMessages(store, role, outstanding);
      const last = later.at(-1);
      if (last !== undefined) {
        store.append({
          actor: SYSTEM,
          key: `wake.coalesced:${outstanding}:${last}`,
          kind: "wake.coalesced",
          payload: { messages: later, role, wake: outstanding },
        });
      }
      return { status: "coalesced", wake: state.outstanding };
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
    return { count };
  });
  if ("status" in claim || "reason" in target) {
    return claim as WakeResult;
  }
  const text = wakeText({ count: claim.count, role, seq: 1 });
  let outcome: WakeOutcome;
  let detail: string | null = null;
  let blocker: WakeBlocker | null = null;
  try {
    if (target.harness === "claude") {
      const guard = checkStoreGuard(context, role, target.harness);
      if (guard.status === "clear") {
        writeWakeFile(context.layout, target.conversation, { count: claim.count, role });
        outcome = "accepted";
      } else {
        detail = safeWakeReason(guard.reason, "store-guard");
        blocker = safeWakeBlocker(guard.blocker, role);
        outcome = "guarded";
      }
    } else {
      ({ blocker, detail, outcome } = await codexWake(context, role, target, wake, text));
    }
  } catch (error) {
    outcome = target.harness === "claude" ? "failed" : "ambiguous";
    detail = safeWakeReason(error instanceof StoreError ? error.code : null, "wake-error");
  }
  store.append({
    actor: SYSTEM,
    key: `wake.completed:${wake}`,
    kind: "wake.completed",
    payload: { blocker: blockerPayload(blocker), detail, outcome, role, wake },
  });
  return { status: outcome, wake };
}
