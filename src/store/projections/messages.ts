// Messages, the per-role wake state and the wake attempts.
import type { DatabaseSync } from "node:sqlite";

import { payloadJson as json, payloadText as text } from "../eventCodec.ts";
import type { JsonObject, Projection, StoredEvent } from "../types.ts";

const MESSAGES_DDL = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  intent TEXT NOT NULL,
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  links TEXT NOT NULL,
  worker TEXT,
  state TEXT NOT NULL CHECK (state IN ('sent', 'delivered', 'handled', 'retained', 'superseded')),
  unconfirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_seq INTEGER NOT NULL,
  delivered_at TEXT,
  closed_at TEXT,
  work TEXT,
  superseded_by TEXT,
  evidence TEXT NOT NULL DEFAULT '[]',
  retention TEXT,
  legacy TEXT,
  updated_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages (to_role, state, sent_seq);
CREATE INDEX IF NOT EXISTS messages_from ON messages (from_role, sent_seq);
CREATE TABLE IF NOT EXISTS wake_state (
  role TEXT PRIMARY KEY,
  pending INTEGER NOT NULL DEFAULT 0,
  outstanding TEXT
);
CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  harness TEXT,
  conversation TEXT,
  count INTEGER NOT NULL,
  at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  outcome TEXT,
  detail TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS wakes_role ON wakes (role, seq);
`;

function setPending(db: DatabaseSync, role: string): void {
  db.prepare(
    `INSERT INTO wake_state (role, pending, outstanding) VALUES (?, 1, NULL)
     ON CONFLICT (role) DO UPDATE SET pending = 1`,
  ).run(role);
}

const sent = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT INTO messages (id, from_role, to_role, intent, body, body_sha256, links, worker, state,
       created_at, sent_seq, updated_seq, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)`,
  ).run(
    text(p, "id"),
    text(p, "from"),
    text(p, "to"),
    text(p, "intent"),
    text(p, "body"),
    text(p, "bodySha256"),
    json(p, "links"),
    text(p, "worker"),
    text(p, "createdAt"),
    event.seq,
    event.seq,
    event.at,
  );
  setPending(db, text(p, "to")!);
};

const imported = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT INTO messages (id, from_role, to_role, intent, body, body_sha256, links, worker, state,
       unconfirmed, created_at, sent_seq, delivered_at, closed_at, work, superseded_by, evidence,
       retention, legacy, updated_seq, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    text(p, "id"),
    text(p, "from"),
    text(p, "to"),
    text(p, "intent"),
    text(p, "body"),
    text(p, "bodySha256"),
    json(p, "links"),
    text(p, "state"),
    p.unconfirmed === true ? 1 : 0,
    text(p, "createdAt"),
    event.seq,
    text(p, "deliveredAt"),
    text(p, "closedAt"),
    text(p, "work"),
    text(p, "supersededBy"),
    json(p, "evidence"),
    p.retention === null || typeof p.retention !== "object"
      ? null
      : JSON.stringify({ ...(p.retention as JsonObject), at: event.at }),
    json(p, "legacy"),
    event.seq,
    event.at,
  );
  if (p.state === "sent") {
    setPending(db, text(p, "to")!);
  }
};

const inboxRead = (db: DatabaseSync, event: StoredEvent): void => {
  const role = text(event.payload, "role")!;
  const update = db.prepare(
    `UPDATE messages SET state = 'delivered', delivered_at = ?, updated_seq = ?, updated_at = ?
     WHERE id = ? AND to_role = ? AND state = 'sent'`,
  );
  for (const id of (event.payload.delivered as readonly string[] | undefined) ?? []) {
    update.run(event.at, event.seq, event.at, id, role);
  }
  db.prepare(
    `INSERT INTO wake_state (role, pending, outstanding) VALUES (?, 0, NULL)
     ON CONFLICT (role) DO UPDATE SET pending = 0, outstanding = NULL`,
  ).run(role);
};

const closed = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  // A journal may hold generated coordinator attention closed without delivery.
  const retiredAttention =
    event.actor.role === "game-coordinator" &&
    event.actor.nativeId === null &&
    Array.isArray(p.evidence) &&
    p.evidence[0] === "attention-source-cleared";
  db.prepare(
    `UPDATE messages SET state = ?, closed_at = ?, delivered_at = COALESCE(delivered_at, ?),
       work = ?, superseded_by = ?, evidence = ?, updated_seq = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    text(p, "state"),
    event.at,
    retiredAttention ? null : event.at,
    text(p, "work"),
    text(p, "supersededBy"),
    json(p, "evidence"),
    event.seq,
    event.at,
    text(p, "id"),
  );
};

const retained = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `UPDATE messages SET state = 'retained', delivered_at = COALESCE(delivered_at, ?),
       retention = ?, evidence = COALESCE(?, evidence), updated_seq = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    event.at,
    JSON.stringify({
      at: event.at,
      nextBoundary: text(p, "nextBoundary"),
      owner: text(p, "owner"),
      reason: text(p, "reason"),
    }),
    p.evidence === undefined ? null : json(p, "evidence"),
    event.seq,
    event.at,
    text(p, "id"),
  );
};

const wakeClaimed = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT INTO wakes (id, role, harness, conversation, count, at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    text(p, "wake"),
    text(p, "role"),
    text(p, "harness"),
    text(p, "conversation"),
    Number(p.count),
    event.at,
    event.seq,
  );
  db.prepare(
    `INSERT INTO wake_state (role, pending, outstanding) VALUES (?, 1, ?)
     ON CONFLICT (role) DO UPDATE SET outstanding = excluded.outstanding`,
  ).run(text(p, "role"), text(p, "wake"));
};

const wakeCompleted = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(`UPDATE wakes SET outcome = ?, detail = ?, completed_at = ? WHERE id = ?`).run(
    text(p, "outcome"),
    text(p, "detail"),
    event.at,
    text(p, "wake"),
  );
  // A wake refused before any native action leaves nothing outstanding.
  if (p.outcome === "guarded") {
    db.prepare(`UPDATE wake_state SET outstanding = NULL WHERE role = ? AND outstanding = ?`).run(
      text(p, "role"),
      text(p, "wake"),
    );
  }
};

const wakeGuarded = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT INTO wakes (id, role, harness, conversation, count, at, seq, outcome, detail, completed_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 'guarded', ?, ?)`,
  ).run(
    text(p, "wake"),
    text(p, "role"),
    text(p, "harness"),
    Number(p.count),
    event.at,
    event.seq,
    text(p, "reason"),
    event.at,
  );
};

const wakeRearmed = (db: DatabaseSync, event: StoredEvent): void => {
  db.prepare(`UPDATE wake_state SET outstanding = NULL WHERE role = ?`).run(
    text(event.payload, "role"),
  );
};

/** A journal may hold native notice proofs, each of which ended its exact outstanding wake. */
const noticeEnded = (db: DatabaseSync, event: StoredEvent): void => {
  db.prepare(`UPDATE wake_state SET outstanding = NULL WHERE role = ? AND outstanding = ?`).run(
    text(event.payload, "role"),
    text(event.payload, "id"),
  );
};

export const MESSAGES_PROJECTION: Projection = {
  apply: {
    "inbox.read": inboxRead,
    "msg.closed": closed,
    "msg.imported": imported,
    "msg.retained": retained,
    "msg.sent": sent,
    "notice.consumed": noticeEnded,
    "notice.released": noticeEnded,
    "wake.claimed": wakeClaimed,
    "wake.completed": wakeCompleted,
    "wake.guarded": wakeGuarded,
    "wake.rearmed": wakeRearmed,
  },
  ddl: MESSAGES_DDL,
  tables: ["messages", "wake_state", "wakes"],
};
