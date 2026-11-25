// The latest session per role and the handoff records with their per-role times.
import type { DatabaseSync } from "node:sqlite";

import { payloadText as text } from "../eventCodec.ts";
import type { JsonObject, Projection, StoredEvent } from "../types.ts";

/** The hold `handoff ready` sets for a role: `/` in a game role is written as `-`. */
export function handoffHoldId(id: string, role: string): string {
  return `handoff-${id}-${role.replaceAll("/", "-")}`;
}

const HANDOFFS_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  role TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  version TEXT NOT NULL,
  cwd TEXT NOT NULL,
  started_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  from_harness TEXT NOT NULL,
  to_harness TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('preparing', 'prepared', 'sent', 'completed', 'cancelled')),
  opened_at TEXT NOT NULL,
  opened_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoff_roles (
  handoff TEXT NOT NULL,
  role TEXT NOT NULL,
  from_harness TEXT NOT NULL,
  ready_at TEXT,
  active_at TEXT,
  PRIMARY KEY (handoff, role)
);
`;

const sessionStarted = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT OR REPLACE INTO sessions (role, harness, native_id, version, cwd, started_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    text(p, "role"),
    text(p, "harness"),
    text(p, "nativeId"),
    text(p, "version"),
    text(p, "cwd"),
    event.at,
    event.seq,
  );
};

const opened = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  const roles = (Array.isArray(p.roles) ? (p.roles as readonly JsonObject[]) : []).map((item) => ({
    from: text(item, "from"),
    role: text(item, "role"),
  }));
  db.prepare(
    `INSERT INTO handoffs (id, scope, from_harness, to_harness, state, opened_at, opened_seq,
       updated_at) VALUES (?, ?, ?, ?, 'preparing', ?, ?, ?)`,
  ).run(
    text(p, "id"),
    JSON.stringify(roles.map((item) => item.role)),
    text(p, "from"),
    text(p, "to"),
    event.at,
    event.seq,
    event.at,
  );
  const insert = db.prepare(
    "INSERT INTO handoff_roles (handoff, role, from_harness) VALUES (?, ?, ?)",
  );
  for (const item of roles) {
    insert.run(text(p, "id"), item.role, item.from);
  }
};

const roleMark =
  (column: "ready_at" | "active_at") =>
  (db: DatabaseSync, event: StoredEvent): void => {
    const p = event.payload;
    db.prepare(`UPDATE handoff_roles SET ${column} = ? WHERE handoff = ? AND role = ?`).run(
      event.at,
      text(p, "id"),
      text(p, "role"),
    );
    db.prepare("UPDATE handoffs SET updated_at = ? WHERE id = ?").run(event.at, text(p, "id"));
  };

const stateSet = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare("UPDATE handoffs SET state = ?, updated_at = ? WHERE id = ?").run(
    text(p, "state"),
    event.at,
    text(p, "id"),
  );
};

/** The latest session per role and the handoff records with their per-role times. */
export const HANDOFFS_PROJECTION: Projection = {
  apply: {
    "handoff.active": roleMark("active_at"),
    "handoff.opened": opened,
    "handoff.ready": roleMark("ready_at"),
    "handoff.state": stateSet,
    "session.started": sessionStarted,
  },
  ddl: HANDOFFS_DDL,
  tables: ["sessions", "handoffs", "handoff_roles"],
};
