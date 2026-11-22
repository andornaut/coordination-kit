import type { DatabaseSync } from "node:sqlite";

import type { Store } from "./db.ts";
import type { Projection } from "./projections.ts";
import { secretShape } from "./secrets.ts";
import type {
  JsonObject,
  MessageState,
  MessageWakeView,
  StoredEvent,
  UnreadMessage,
  WakeBlocker,
} from "./types.ts";

type Reader = Pick<Store, "db">;
const CODE = /^[a-z][a-z0-9-]{0,95}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ROLE = /^[a-z0-9][a-z0-9-]{0,63}(?:\/[a-z0-9][a-z0-9-]{0,63})?$/;
const BLOCKER_KINDS = ["question", "hold", "policy-hold", "registry", "wake", "native-question"];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function safeWakeReason(input: unknown, fallback: string): string {
  return typeof input === "string" && CODE.test(input) && secretShape(input) === null
    ? input
    : fallback;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value) && secretShape(value) === null;
}

export function safeWakeBlocker(input: unknown, owner: string): WakeBlocker | null {
  const value = record(input);
  const blockerOwner = value?.kind === "policy-hold" ? "game-coordinator" : owner;
  if (
    value === null ||
    value.owner !== blockerOwner ||
    !ROLE.test(owner) ||
    typeof value.kind !== "string" ||
    !BLOCKER_KINDS.includes(value.kind) ||
    !safeId(value.id)
  ) {
    return null;
  }
  const native = record(value.native);
  const reference =
    (value.kind === "question" || value.kind === "native-question") &&
    safeId(native?.turnId) &&
    safeId(native.itemId)
      ? { itemId: native.itemId, turnId: native.turnId }
      : null;
  if (value.kind === "native-question" && reference === null) {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind as WakeBlocker["kind"],
    owner: blockerOwner,
    ...(reference === null ? {} : { native: reference }),
  };
}

function exactMessages(db: DatabaseSync, event: StoredEvent): void {
  const { blocker, messages, role, wake } = event.payload;
  if (!Array.isArray(messages) || typeof role !== "string" || typeof wake !== "string") {
    return;
  }
  const safe = safeWakeBlocker(blocker, role);
  const insert = db.prepare(
    `INSERT INTO message_wakes (message_id, wake_id, seq, coalesced, blocker)
     SELECT m.id, ?, ?, ?, ? FROM messages m WHERE m.id = ? AND m.to_role = ?
     ON CONFLICT (message_id, wake_id) DO NOTHING`,
  );
  for (const id of messages) {
    if (typeof id === "string") {
      insert.run(wake, event.seq, event.kind === "wake.coalesced" ? 1 : 0, encode(safe), id, role);
    }
  }
}

function encode(value: WakeBlocker | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

export function blockerPayload(value: WakeBlocker | null): JsonObject | null {
  return value === null ? null : { ...value };
}

export const MESSAGE_WAKE_PROJECTION: Projection = {
  apply: {
    "wake.claimed": exactMessages,
    "wake.coalesced": exactMessages,
    "wake.completed": (db, event) => {
      const { blocker, role, wake } = event.payload;
      if (typeof role === "string" && typeof wake === "string") {
        db.prepare("UPDATE message_wakes SET blocker = ? WHERE wake_id = ? AND coalesced = 0").run(
          encode(safeWakeBlocker(blocker, role)),
          wake,
        );
      }
    },
    "wake.guarded": exactMessages,
  },
  ddl: `CREATE TABLE IF NOT EXISTS message_wakes (
    message_id TEXT NOT NULL,
    wake_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    coalesced INTEGER NOT NULL,
    blocker TEXT,
    PRIMARY KEY (message_id, wake_id)
  );
  CREATE INDEX IF NOT EXISTS message_wakes_latest ON message_wakes (message_id, seq DESC);
  CREATE INDEX IF NOT EXISTS message_wakes_attempt ON message_wakes (wake_id);`,
  tables: ["message_wakes"],
};

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
