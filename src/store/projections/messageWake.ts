// Each message's wake attempts and their safe blockers. Blocker and reason text is validated
// before it is stored or printed, so nothing private reaches the projection.
import type { DatabaseSync } from "node:sqlite";

import { secretShape } from "../secrets.ts";
import type { JsonObject, Projection, StoredEvent, WakeBlocker } from "../types.ts";

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
