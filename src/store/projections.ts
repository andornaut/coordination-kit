// Projections: tables derived from the events, updated in the append transaction and rebuilt by
// `Store.rebuild`. Each projection lists its tables, their DDL and one applier per event kind.
// Kinds without an applier are stored and chained but project nothing, so a later projection can
// add appliers for existing kinds and pick them up on the next rebuild.
import type { DatabaseSync } from "node:sqlite";

import type { JsonObject, StoredEvent } from "./types.ts";
import { WORK_PROJECTION } from "./work.ts";

export interface Projection {
  readonly tables: readonly string[];
  readonly ddl: string;
  readonly apply: Readonly<Record<string, (db: DatabaseSync, event: StoredEvent) => void>>;
}

function text(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function json(payload: JsonObject, key: string): string {
  return JSON.stringify(payload[key] ?? null);
}

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
  db.prepare(
    `UPDATE messages SET state = ?, closed_at = ?, delivered_at = COALESCE(delivered_at, ?),
       work = ?, superseded_by = ?, evidence = ?, updated_seq = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    text(p, "state"),
    event.at,
    event.at,
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
       retention = ?, updated_seq = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    event.at,
    JSON.stringify({
      at: event.at,
      nextBoundary: text(p, "nextBoundary"),
      owner: text(p, "owner"),
      reason: text(p, "reason"),
    }),
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

export const MESSAGES_PROJECTION: Projection = {
  apply: {
    "inbox.read": inboxRead,
    "msg.closed": closed,
    "msg.imported": imported,
    "msg.retained": retained,
    "msg.sent": sent,
    "wake.claimed": wakeClaimed,
    "wake.completed": wakeCompleted,
    "wake.guarded": wakeGuarded,
    "wake.rearmed": wakeRearmed,
  },
  ddl: MESSAGES_DDL,
  tables: ["messages", "wake_state", "wakes"],
};

const DELIVERY_DDL = `
CREATE TABLE IF NOT EXISTS bus_events (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  type TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT,
  sha TEXT,
  at TEXT NOT NULL,
  work TEXT,
  seq INTEGER NOT NULL,
  UNIQUE (game, type, key)
);
CREATE INDEX IF NOT EXISTS bus_events_sha ON bus_events (game, sha, seq);
CREATE TABLE IF NOT EXISTS bus_completes (
  game TEXT NOT NULL,
  sha TEXT NOT NULL,
  source TEXT NOT NULL,
  message_id TEXT,
  work TEXT,
  seq INTEGER NOT NULL,
  PRIMARY KEY (game, sha)
);
CREATE TABLE IF NOT EXISTS bus_work (
  game TEXT NOT NULL,
  work TEXT NOT NULL,
  sha TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (game, work)
);
CREATE TABLE IF NOT EXISTS review_briefs (
  game TEXT NOT NULL,
  slot INTEGER NOT NULL,
  recipient TEXT NOT NULL,
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (game, slot)
);
`;

const busEvent = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT OR IGNORE INTO bus_events (id, game, type, key, kind, status, sha, at, work, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    text(p, "id"),
    text(p, "game"),
    text(p, "type"),
    text(p, "key"),
    text(p, "kind"),
    text(p, "status"),
    text(p, "sha"),
    text(p, "at"),
    json(p, "work"),
    event.seq,
  );
};

const busComplete = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT OR IGNORE INTO bus_completes (game, sha, source, message_id, work, seq)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    text(p, "game"),
    text(p, "sha"),
    text(p, "source"),
    text(p, "messageId"),
    json(p, "work"),
    event.seq,
  );
  // The first COMPLETE that lists a work ID records it for the game.
  const work = db.prepare(
    "INSERT OR IGNORE INTO bus_work (game, work, sha, seq) VALUES (?, ?, ?, ?)",
  );
  for (const id of Array.isArray(p.work) ? (p.work as readonly unknown[]) : []) {
    if (typeof id === "string") {
      work.run(text(p, "game"), id, text(p, "sha"), event.seq);
    }
  }
};

const reviewBrief = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT OR IGNORE INTO review_briefs (game, slot, recipient, message_id, seq)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(text(p, "game"), Number(p.slot), text(p, "recipient"), text(p, "messageId"), event.seq);
};

/** Runner events, COMPLETE records, recorded work IDs and stored review briefs. */
export const DELIVERY_PROJECTION: Projection = {
  apply: {
    "bus.complete": busComplete,
    "bus.event": busEvent,
    "review.brief": reviewBrief,
  },
  ddl: DELIVERY_DDL,
  tables: ["bus_events", "bus_completes", "bus_work", "review_briefs"],
};

/** Every projection, in apply order. A later phase appends its own here. */
export const PROJECTIONS: readonly Projection[] = [
  MESSAGES_PROJECTION,
  DELIVERY_PROJECTION,
  WORK_PROJECTION,
];
