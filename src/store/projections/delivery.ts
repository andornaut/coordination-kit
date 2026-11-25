// Runner events, COMPLETE records, recorded work IDs and stored review briefs.
import type { DatabaseSync } from "node:sqlite";

import { payloadJson as json, payloadText as text } from "../eventCodec.ts";
import type { Projection, StoredEvent } from "../types.ts";

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
