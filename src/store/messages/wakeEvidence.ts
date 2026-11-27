import type { Store } from "../db.ts";
import type { ProjectionRow } from "../projectionIndex.ts";
import { safeWakeReason, storedWakeBlocker } from "../projections/messageWake.ts";
import type { MessageState, MessageWakeView, UnreadMessage } from "../types.ts";
import { messageRow, messageRows } from "./messages.ts";

type Reader = Pick<Store, "index">;

/** Later arrivals were outside the outstanding attempt, even when older membership is unknown. */
export function coalescedMessages(
  store: Reader,
  role: string,
  wake: string,
  afterSeq: number,
): string[] {
  return messageRows(store, role, ["sent"])
    .filter(
      ({ id, sent_seq }) =>
        Number(sent_seq) > afterSeq && store.index.get("message_wakes", [id!, wake]) === undefined,
    )
    .map(({ id }) => id as string);
}

interface WakeRow {
  readonly wake_id: string;
  readonly coalesced: number;
  readonly outcome: string | null;
  readonly detail: string | null;
  readonly blocker: string | null;
}

function withAttempt(store: Reader, link: ProjectionRow | undefined): WakeRow | undefined {
  if (link === undefined) {
    return undefined;
  }
  const wake = link.wake_id as string;
  const attempt = store.index.get("wakes", [wake]);
  return {
    blocker: link.blocker as string | null,
    coalesced: Number(link.coalesced),
    detail: (attempt?.detail as string | null) ?? null,
    outcome: (attempt?.outcome as string | null) ?? null,
    wake_id: wake,
  };
}

function exactLink(store: Reader, id: string, latest: boolean): ProjectionRow | undefined {
  let found: ProjectionRow | undefined;
  for (const row of store.index.rows("message_wakes")) {
    if (row.message_id !== id) {
      continue;
    }
    if (
      found === undefined ||
      (latest ? Number(row.seq) > Number(found.seq) : Number(row.seq) < Number(found.seq))
    ) {
      found = row;
    }
  }
  return found;
}

function evidence(store: Reader, to: string, state: MessageState, row?: WakeRow): MessageWakeView {
  const wake = row?.wake_id ?? null;
  const storedOutcome = row?.outcome;
  const outcome =
    row?.coalesced === 1
      ? "coalesced"
      : storedOutcome === "accepted" ||
          storedOutcome === "guarded" ||
          storedOutcome === "failed" ||
          storedOutcome === "ambiguous"
        ? storedOutcome
        : "unknown";
  const reason =
    outcome === "accepted"
      ? null
      : outcome === "unknown"
        ? wake === null
          ? "exact-wake-evidence-unavailable"
          : "wake-outcome-unrecorded"
        : outcome === "coalesced"
          ? "prior-wake-outstanding"
          : safeWakeReason(row?.detail, `wake-${outcome}`);
  const blocker =
    storedWakeBlocker(store.index, row?.blocker == null ? null : JSON.parse(row.blocker), to) ??
    (wake !== null && outcome !== "accepted" ? { id: wake, kind: "wake", owner: to } : null);
  let nextAction: MessageWakeView["nextAction"] = "none";
  if (state === "sent") {
    nextAction =
      outcome === "ambiguous" ||
      ((outcome === "unknown" || outcome === "coalesced") &&
        wake !== null &&
        (storedOutcome === null || storedOutcome === "ambiguous"))
        ? "reconcile-without-resending"
        : "collect-at-safe-boundary";
  } else if (state === "delivered") {
    nextAction = "reconcile-original";
  } else if (state === "retained") {
    nextAction = "follow-retention-boundary";
  }
  return { blocker, nextAction, outcome, reason, wake };
}

/** Reads never upgrade the store or infer historical membership from recipient and time. */
export function messageWake(
  store: Reader,
  id: string,
  to: string,
  state: MessageState,
): MessageWakeView {
  const link = messageRow(store, id) === undefined ? undefined : exactLink(store, id, true);
  return evidence(store, to, state, withAttempt(store, link));
}

/** Earliest exact association, including a coalesced wake that predates this original. */
export function firstMessageWake(
  store: Reader,
  id: string,
  to: string,
): Omit<MessageWakeView, "nextAction"> | null {
  const row = withAttempt(store, exactLink(store, id, false));
  if (row === undefined) {
    return null;
  }
  const { blocker, outcome, reason, wake } = evidence(store, to, "sent", row);
  return { blocker, outcome, reason, wake };
}

export function unreadMessages(store: Reader, role: string | null): UnreadMessage[] {
  const unread = messageRows(store, role, ["sent"]);
  const ids = new Set(unread.map(({ id }) => id));
  const latest = new Map<string, ProjectionRow>();
  for (const row of store.index.rows("message_wakes")) {
    const id = row.message_id as string;
    if (ids.has(id) && Number(row.seq) > Number(latest.get(id)?.seq ?? 0)) {
      latest.set(id, row);
    }
  }
  return unread.map(({ from_role, id, to_role }) => ({
    from: from_role as string,
    id: id as string,
    to: to_role as string,
    wake: evidence(store, to_role as string, "sent", withAttempt(store, latest.get(id as string))),
  }));
}
