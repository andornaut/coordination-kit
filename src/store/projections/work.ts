// Work records, their stage evidence and their retained items.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { payloadText as text } from "../eventCodec.ts";
import type { JsonObject, Projection, StoredEvent } from "../types.ts";

export const WORK_KINDS = [
  "work.started",
  "work.evidence",
  "work.blocked",
  "work.unblocked",
  "work.ready",
  "work.finished",
  "work.retained",
] as const;

const WORK_DDL = `
CREATE TABLE IF NOT EXISTS work (
  repository TEXT NOT NULL,
  id TEXT NOT NULL,
  owner TEXT,
  state TEXT NOT NULL CHECK (state IN ('recorded', 'started', 'blocked', 'ready', 'finished')),
  parent_repository TEXT,
  parent_id TEXT,
  started_at TEXT,
  ready_at TEXT,
  finished_at TEXT,
  block TEXT,
  updated_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository, id)
);
CREATE INDEX IF NOT EXISTS work_parent ON work (parent_repository, parent_id);
CREATE TABLE IF NOT EXISTS work_evidence (
  seq INTEGER PRIMARY KEY,
  repository TEXT NOT NULL,
  id TEXT NOT NULL,
  stage TEXT NOT NULL,
  sha TEXT NOT NULL,
  ref TEXT,
  source TEXT,
  entry TEXT,
  actor TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_evidence_work ON work_evidence (repository, id, seq);
CREATE INDEX IF NOT EXISTS work_evidence_sha ON work_evidence (sha);
CREATE TABLE IF NOT EXISTS work_retained (
  seq INTEGER PRIMARY KEY,
  repository TEXT NOT NULL,
  id TEXT NOT NULL,
  owner TEXT,
  reason TEXT NOT NULL,
  next_boundary TEXT NOT NULL,
  source TEXT,
  entry TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_retained_work ON work_retained (repository, id, seq);
`;

/** Insert the row if missing, apply `set`, then derive the state from the timestamps. */
function touch(
  db: DatabaseSync,
  event: StoredEvent,
  set: string,
  values: readonly SQLInputValue[],
): void {
  const repository = text(event.payload, "repository");
  const id = text(event.payload, "id");
  db.prepare(
    `INSERT INTO work (repository, id, state, updated_seq, updated_at) VALUES (?, ?, 'recorded', ?, ?)
     ON CONFLICT (repository, id) DO NOTHING`,
  ).run(repository, id, event.seq, event.at);
  db.prepare(
    `UPDATE work SET ${set}${set === "" ? "" : ", "}updated_seq = ?, updated_at = ?
     WHERE repository = ? AND id = ?`,
  ).run(...values, event.seq, event.at, repository, id);
  db.prepare(
    `UPDATE work SET state = CASE
       WHEN finished_at IS NOT NULL THEN 'finished'
       WHEN block IS NOT NULL THEN 'blocked'
       WHEN ready_at IS NOT NULL THEN 'ready'
       WHEN started_at IS NOT NULL THEN 'started'
       ELSE 'recorded' END
     WHERE repository = ? AND id = ?`,
  ).run(repository, id);
}

function parentOf(payload: JsonObject): { repository: string | null; id: string | null } {
  const parent = payload.parent;
  if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
    return { id: null, repository: null };
  }
  const value = parent as JsonObject;
  return { id: text(value, "id"), repository: text(value, "repository") };
}

const started = (db: DatabaseSync, event: StoredEvent): void => {
  const parent = parentOf(event.payload);
  touch(db, event, "owner = ?, started_at = ?, parent_repository = ?, parent_id = ?", [
    text(event.payload, "owner"),
    event.at,
    parent.repository,
    parent.id,
  ]);
};

const evidence = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT INTO work_evidence (seq, repository, id, stage, sha, ref, source, entry, actor, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.seq,
    text(p, "repository"),
    text(p, "id"),
    text(p, "stage"),
    text(p, "sha"),
    text(p, "ref"),
    text(p, "source"),
    text(p, "entry"),
    event.actor.role,
    event.at,
  );
  touch(db, event, "", []);
};

const blocked = (db: DatabaseSync, event: StoredEvent): void => {
  touch(db, event, "block = ?", [
    JSON.stringify({
      at: event.at,
      owner: text(event.payload, "blockOwner"),
      reason: text(event.payload, "reason"),
    }),
  ]);
};

const unblocked = (db: DatabaseSync, event: StoredEvent): void => {
  touch(db, event, "block = NULL", []);
};

const ready = (db: DatabaseSync, event: StoredEvent): void => {
  touch(db, event, "ready_at = ?", [event.at]);
};

const finished = (db: DatabaseSync, event: StoredEvent): void => {
  touch(db, event, "owner = COALESCE(?, owner), finished_at = ?, block = NULL", [
    text(event.payload, "owner"),
    event.at,
  ]);
};

const retainedItem = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT INTO work_retained (seq, repository, id, owner, reason, next_boundary, source, entry, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.seq,
    text(p, "repository"),
    text(p, "id"),
    text(p, "owner"),
    text(p, "reason"),
    text(p, "nextBoundary"),
    text(p, "source"),
    text(p, "entry"),
    event.at,
  );
  touch(db, event, "", []);
};

/** Work records, their stage evidence and their retained items. */
export const WORK_PROJECTION: Projection = {
  apply: {
    "work.blocked": blocked,
    "work.evidence": evidence,
    "work.finished": finished,
    "work.ready": ready,
    "work.retained": retainedItem,
    "work.started": started,
    "work.unblocked": unblocked,
  },
  ddl: WORK_DDL,
  tables: ["work", "work_evidence", "work_retained"],
};
