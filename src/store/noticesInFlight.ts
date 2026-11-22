// Exact Codex input per owner and conversation survives durable inbox pulls.
import type { DatabaseSync } from "node:sqlite";

import { wakeText } from "../adapters/claude/wakeFile.ts";
import type { Projection } from "./projections.ts";
import type { JsonObject, StoredEvent } from "./types.ts";

export interface PendingNotice {
  readonly id: string;
  readonly role: string;
  readonly conversation: string;
  readonly origin: "wake" | "reminder";
  readonly seq: number;
  readonly count: number;
  readonly readyForProof: number;
}

export interface NoticeBinding {
  readonly role: string;
  readonly conversation: string;
}

type Reader = { readonly db: DatabaseSync };

function string(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function claim(db: DatabaseSync, event: StoredEvent, origin: PendingNotice["origin"]): void {
  const p = event.payload;
  const id = string(p, origin === "wake" ? "wake" : "id");
  const role = string(p, "role");
  const conversation = string(p, origin === "wake" ? "conversation" : "nativeId");
  const count = origin === "wake" ? p.count : Array.isArray(p.originals) ? p.originals.length : 0;
  if (
    p.harness === "codex" &&
    id !== null &&
    role !== null &&
    conversation !== null &&
    typeof count === "number" &&
    Number.isSafeInteger(count) &&
    count > 0
  ) {
    db.prepare(
      `INSERT INTO pending_notices (id, role, conversation, origin, seq, count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, role, conversation, origin, event.seq, count);
  }
}

function conclude(db: DatabaseSync, id: string | null, origin: PendingNotice["origin"]): void {
  db.prepare("DELETE FROM pending_notices WHERE id = ? AND origin = ?").run(id, origin);
}

export const NOTICE_PROJECTION: Projection = {
  apply: {
    "notice.consumed": (db, { payload: p }) => {
      db.prepare("DELETE FROM pending_notices WHERE id = ? AND role = ? AND conversation = ?").run(
        string(p, "id"),
        string(p, "role"),
        string(p, "conversation"),
      );
      db.prepare("UPDATE wake_state SET outstanding = NULL WHERE role = ? AND outstanding = ?").run(
        string(p, "role"),
        string(p, "id"),
      );
    },
    "reminder.claimed": (db, event) => claim(db, event, "reminder"),
    "reminder.settled": (db, { payload: p }) => {
      if (p.outcome === "refused") {
        conclude(db, string(p, "id"), "reminder");
      }
    },
    "wake.claimed": (db, event) => claim(db, event, "wake"),
    "wake.completed": (db, { payload: p }) => {
      if (p.outcome === "failed" || p.outcome === "guarded") {
        conclude(db, string(p, "wake"), "wake");
      }
    },
  },
  ddl: `CREATE TABLE IF NOT EXISTS pending_notices (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    conversation TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('wake', 'reminder')),
    seq INTEGER NOT NULL,
    count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pending_notices_binding ON pending_notices(role, conversation, seq);`,
  tables: ["pending_notices"],
};

export function pendingNotices(store: Reader, binding: NoticeBinding): PendingNotice[] {
  if (
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'pending_notices'").get() ===
    undefined
  ) {
    return [];
  }
  return store.db
    .prepare(
      `SELECT n.id, n.role, n.conversation, n.origin, n.seq, n.count,
        (n.origin = 'wake' OR c.outcome IS NOT NULL) AS readyForProof
     FROM pending_notices n LEFT JOIN reminder_claims c ON c.id = n.id
     WHERE n.role = ? AND n.conversation = ? ORDER BY n.seq`,
    )
    .all(binding.role, binding.conversation) as unknown as PendingNotice[];
}

export function noticeText(count: number, role: string, reminderId?: string): string {
  const text = wakeText({ count, role, seq: 1 });
  return reminderId === undefined ? text : `${text} [${reminderId}]`;
}
