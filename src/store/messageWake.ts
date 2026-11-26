import type { Store } from "./db.ts";
import { safeWakeBlocker, safeWakeReason } from "./projections/messageWake.ts";
import type { MessageState, MessageWakeView, UnreadMessage } from "./types.ts";

type Reader = Pick<Store, "db">;

function hasProjection(store: Reader): boolean {
  return (
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'message_wakes'").get() !== undefined
  );
}

/** Later arrivals were outside the outstanding attempt, even when older membership is unknown. */
export function coalescedMessages(
  store: Reader,
  role: string,
  wake: string,
  afterSeq: number,
): string[] {
  return (
    store.db
      .prepare(
        `SELECT m.id FROM messages m
       WHERE m.to_role = ? AND m.state = 'sent' AND m.sent_seq > ? AND NOT EXISTS (
         SELECT 1 FROM message_wakes WHERE message_id = m.id AND wake_id = ?
       )
       ORDER BY m.sent_seq`,
      )
      .all(role, afterSeq, wake) as { id: string }[]
  ).map(({ id }) => id);
}

interface WakeRow {
  readonly wake_id: string | null;
  readonly coalesced: number | null;
  readonly outcome: string | null;
  readonly detail: string | null;
  readonly blocker: string | null;
}

const LATEST = `LEFT JOIN message_wakes mw ON mw.message_id = m.id AND mw.seq = (
  SELECT seq FROM message_wakes WHERE message_id = m.id ORDER BY seq DESC LIMIT 1
) LEFT JOIN wakes w ON w.id = mw.wake_id`;
const EVIDENCE = "mw.wake_id, mw.coalesced, w.outcome, w.detail, mw.blocker";

function evidence(to: string, state: MessageState, row?: WakeRow): MessageWakeView {
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
    safeWakeBlocker(row?.blocker == null ? null : JSON.parse(row.blocker), to) ??
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
  const row = hasProjection(store)
    ? (store.db
        .prepare(`SELECT ${EVIDENCE} FROM messages m ${LATEST} WHERE m.id = ?`)
        .get(id) as unknown as WakeRow | undefined)
    : undefined;
  return evidence(to, state, row);
}

/** Earliest exact association, including a coalesced wake that predates this original. */
export function firstMessageWake(
  store: Reader,
  id: string,
  to: string,
): Omit<MessageWakeView, "nextAction"> | null {
  const row = hasProjection(store)
    ? (store.db
        .prepare(
          `SELECT ${EVIDENCE} FROM message_wakes mw LEFT JOIN wakes w ON w.id = mw.wake_id
           WHERE mw.message_id = ? ORDER BY mw.seq LIMIT 1`,
        )
        .get(id) as unknown as WakeRow | undefined)
    : undefined;
  if (row === undefined) {
    return null;
  }
  const { blocker, outcome, reason, wake } = evidence(to, "sent", row);
  return { blocker, outcome, reason, wake };
}

export function unreadMessages(store: Reader, role: string | null): UnreadMessage[] {
  const base = `FROM messages m WHERE m.state = 'sent' AND (? IS NULL OR m.to_role = ?) ORDER BY m.sent_seq`;
  if (!hasProjection(store)) {
    const rows = store.db
      .prepare(`SELECT m.id, m.from_role, m.to_role ${base}`)
      .all(role, role) as { id: string; from_role: string; to_role: string }[];
    return rows.map(({ from_role, id, to_role }) => ({
      from: from_role,
      id,
      to: to_role,
      wake: evidence(to_role, "sent"),
    }));
  }
  const rows = store.db
    .prepare(
      `SELECT m.id, m.from_role, m.to_role, ${EVIDENCE}
     FROM messages m ${LATEST} WHERE m.state = 'sent' AND (? IS NULL OR m.to_role = ?) ORDER BY m.sent_seq`,
    )
    .all(role, role) as unknown as (WakeRow & { id: string; from_role: string; to_role: string })[];
  return rows.map((row) => ({
    from: row.from_role,
    id: row.id,
    to: row.to_role,
    wake: evidence(row.to_role, "sent", row),
  }));
}
