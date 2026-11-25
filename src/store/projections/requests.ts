// Requests imported from the retired request ledger and their closes.
import type { DatabaseSync } from "node:sqlite";

import { payloadText as text } from "../eventCodec.ts";
import type { JsonObject, Projection, StoredEvent } from "../types.ts";

const DDL = `
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL,
  question TEXT,
  source_origin TEXT,
  source_reference TEXT,
  work TEXT NOT NULL,
  reason TEXT,
  required_owner TEXT,
  updated_at TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  imported_seq INTEGER NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  close_work TEXT
);
CREATE INDEX IF NOT EXISTS requests_owner ON requests (owner, closed_at);
`;

const imported = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  const source = (p.source ?? {}) as JsonObject;
  db.prepare(
    `INSERT OR IGNORE INTO requests (id, owner, kind, summary, state, question, source_origin,
       source_reference, work, reason, required_owner, updated_at, imported_at, imported_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    text(p, "id"),
    text(p, "owner"),
    text(p, "kind") ?? "request",
    text(p, "summary") ?? "",
    text(p, "state") ?? "open",
    text(p, "question"),
    text(source, "origin"),
    text(source, "reference"),
    JSON.stringify(Array.isArray(p.work) ? p.work : []),
    text(p, "reason"),
    text(p, "requiredOwner"),
    text(p, "updatedAt") ?? event.at,
    event.at,
    event.seq,
  );
};

const closed = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `UPDATE requests SET closed_at = ?, close_reason = ?, close_work = ? WHERE id = ?`,
  ).run(event.at, text(p, "reason"), text(p, "work"), text(p, "id"));
};

export const REQUESTS_PROJECTION: Projection = {
  apply: { "request.closed": closed, "request.imported": imported },
  ddl: DDL,
  tables: ["requests"],
};
