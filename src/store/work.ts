// Work records over the store: start, stage evidence, block, ready and finish for each approved
// work item, keyed by (repository, work ID). Approval, owner and scope stay in the work file on the
// repository's `main`; the store holds only live progress. Every function trusts its `actor`: the
// CLI applies the registry fence and the repository owner check first (src/work/live.ts).
import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { Store } from "./db.ts";
import type { PolicyHoldView } from "./policyHolds.ts";
import type { Projection } from "./projections.ts";
import { secretShape } from "./secrets.ts";
import { type Actor, type JsonObject, type StoredEvent, StoreError } from "./types.ts";

export const WORK_STAGES = ["implemented", "merged", "verified", "published", "deployed"] as const;
export type WorkStage = (typeof WORK_STAGES)[number];
export type WorkState = "recorded" | "started" | "blocked" | "ready" | "finished";
export const WORK_KINDS = [
  "work.started",
  "work.evidence",
  "work.blocked",
  "work.unblocked",
  "work.ready",
  "work.finished",
  "work.retained",
] as const;

/** `<prefix>-` and a zero-padded sequence, as in the work-file convention. */
export const WORK_ID = /^[a-z][a-z0-9]*-\d{4,}$/;
export const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A Git object name: abbreviated (7 or more) up to a full SHA-1 or SHA-256, lower case. */
export const SHA = /^[0-9a-f]{7,64}$/;
const MAX_TEXT = 2000;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface WorkRef {
  readonly repository: string;
  readonly id: string;
}

export interface WorkEvidence {
  readonly stage: WorkStage;
  readonly sha: string;
  readonly ref: string | null;
  /** `approval-ledger` for imported evidence, else null. */
  readonly source: string | null;
  /** The approval-ledger entry an imported event came from, else null. */
  readonly entry: string | null;
  readonly at: string;
  readonly actor: string | null;
}

export interface WorkRetained {
  readonly owner: string | null;
  readonly reason: string;
  readonly nextBoundary: string;
  readonly source: string | null;
  readonly entry: string | null;
  readonly at: string;
}

export interface WorkBlock {
  readonly reason: string;
  readonly owner: string | null;
  readonly at: string;
}

export interface WorkRecord extends WorkRef {
  /** The owner recorded at start or finish; null for a record made only by import. */
  readonly owner: string | null;
  readonly state: WorkState;
  readonly parent: WorkRef | null;
  readonly children: readonly WorkRef[];
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly finishedAt: string | null;
  readonly block: WorkBlock | null;
  readonly evidence: readonly WorkEvidence[];
  readonly retained: readonly WorkRetained[];
  readonly updatedAt: string;
}

type Row = Record<string, SQLInputValue>;

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new StoreError(code);
  }
}

function text(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/** One line of free text: non-empty, bounded and not secret-shaped. */
export function workText(value: string, code: string): string {
  ensure(value.trim() !== "" && value.length <= MAX_TEXT && !/[\r\n]/.test(value), code);
  ensure(secretShape(value) === null, "secret-shaped-text");
  return value;
}

export function checkRef(ref: WorkRef): WorkRef {
  ensure(REPOSITORY_NAME.test(ref.repository), "invalid-repository");
  ensure(WORK_ID.test(ref.id), "invalid-work-id");
  return { id: ref.id, repository: ref.repository };
}

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

function workRow(db: DatabaseSync, ref: WorkRef): Row | undefined {
  return db
    .prepare("SELECT * FROM work WHERE repository = ? AND id = ?")
    .get(ref.repository, ref.id) as Row | undefined;
}

const nullable = (row: Row, key: string): string | null => (row[key] as string | null) ?? null;

/** The record of one work item from an open database (the store's, or a read-only one). */
export function readWorkRecord(db: DatabaseSync, ref: WorkRef): WorkRecord | null {
  const row = workRow(db, ref);
  if (row === undefined) {
    return null;
  }
  const evidenceRows = db
    .prepare("SELECT * FROM work_evidence WHERE repository = ? AND id = ? ORDER BY seq")
    .all(ref.repository, ref.id) as Row[];
  const retainedRows = db
    .prepare("SELECT * FROM work_retained WHERE repository = ? AND id = ? ORDER BY seq")
    .all(ref.repository, ref.id) as Row[];
  const children = db
    .prepare(
      `SELECT repository, id FROM work WHERE parent_repository = ? AND parent_id = ?
       ORDER BY repository, id`,
    )
    .all(ref.repository, ref.id) as Row[];
  const parentRepository = nullable(row, "parent_repository");
  const parentId = nullable(row, "parent_id");
  return {
    block: row.block == null ? null : (JSON.parse(row.block as string) as WorkBlock),
    children: children.map((child) => ({
      id: child.id as string,
      repository: child.repository as string,
    })),
    evidence: evidenceRows.map((item) => ({
      actor: nullable(item, "actor"),
      at: item.at as string,
      entry: nullable(item, "entry"),
      ref: nullable(item, "ref"),
      sha: item.sha as string,
      source: nullable(item, "source"),
      stage: item.stage as WorkStage,
    })),
    finishedAt: nullable(row, "finished_at"),
    id: ref.id,
    owner: nullable(row, "owner"),
    parent:
      parentRepository === null || parentId === null
        ? null
        : { id: parentId, repository: parentRepository },
    readyAt: nullable(row, "ready_at"),
    repository: ref.repository,
    retained: retainedRows.map((item) => ({
      at: item.at as string,
      entry: nullable(item, "entry"),
      nextBoundary: item.next_boundary as string,
      owner: nullable(item, "owner"),
      reason: item.reason as string,
      source: nullable(item, "source"),
    })),
    startedAt: nullable(row, "started_at"),
    state: row.state as WorkState,
    updatedAt: row.updated_at as string,
  };
}

/** Every work record in the store, keyed `repository\nid`. */
export function readWorkRecords(db: DatabaseSync): Map<string, WorkRecord> {
  const records = new Map<string, WorkRecord>();
  for (const row of db.prepare("SELECT repository, id FROM work").all() as Row[]) {
    const ref = { id: row.id as string, repository: row.repository as string };
    const record = readWorkRecord(db, ref);
    if (record !== null) {
      records.set(`${ref.repository}\n${ref.id}`, record);
    }
  }
  return records;
}

export interface WorkWrite {
  readonly record: WorkRecord;
  /** True when the same command was already recorded; nothing was written. */
  readonly duplicate: boolean;
}

function result(store: Store, ref: WorkRef, duplicate: boolean): WorkWrite {
  return { duplicate, record: readWorkRecord(store.db, ref)! };
}

function updatedSeq(store: Store, ref: WorkRef): number {
  return Number(workRow(store.db, ref)?.updated_seq ?? 0);
}

/** `work.started`, once per item. A repeat with the same parent is a duplicate. */
export function startWork(
  store: Store,
  actor: Actor,
  input: { readonly ref: WorkRef; readonly owner: string; readonly parent: WorkRef | null },
): WorkWrite {
  const ref = checkRef(input.ref);
  const parent = input.parent === null ? null : checkRef(input.parent);
  ensure(
    parent === null || parent.repository !== ref.repository || parent.id !== ref.id,
    "invalid-parent",
  );
  return store.transaction(() => {
    const existing = readWorkRecord(store.db, ref);
    if (existing?.startedAt != null) {
      const same =
        (existing.parent === null && parent === null) ||
        (existing.parent !== null &&
          parent !== null &&
          existing.parent.repository === parent.repository &&
          existing.parent.id === parent.id);
      ensure(same, "parent-conflict");
      return { duplicate: true, record: existing };
    }
    ensure(existing?.finishedAt == null, "work-finished");
    store.append({
      actor,
      key: `work.started:${ref.repository}:${ref.id}`,
      kind: "work.started",
      payload: {
        ...ref,
        owner: input.owner,
        parent: parent === null ? null : { id: parent.id, repository: parent.repository },
      },
    });
    return result(store, ref, false);
  });
}

export interface EvidenceInput {
  readonly ref: WorkRef;
  readonly stage: WorkStage;
  readonly sha: string;
  readonly evidenceRef?: string | null;
  readonly source?: string | null;
  readonly entry?: string | null;
}

/** The idempotency key of one stage record: the same stage, commit and reference record once. */
export function evidenceKey(input: EvidenceInput): string {
  return `work.evidence:${input.ref.repository}:${input.ref.id}:${input.stage}:${input.sha}:${sha256(
    input.evidenceRef ?? "",
  ).slice(0, 16)}`;
}

export function checkEvidence(input: EvidenceInput): EvidenceInput {
  checkRef(input.ref);
  ensure((WORK_STAGES as readonly string[]).includes(input.stage), "invalid-stage");
  ensure(SHA.test(input.sha), "invalid-sha");
  if (input.evidenceRef != null) {
    ensure(input.evidenceRef.length <= 512, "invalid-ref");
    workText(input.evidenceRef, "invalid-ref");
  }
  return input;
}

/** `work.evidence`: a stage commit with an optional reference. Allowed after finish. */
export function recordEvidence(store: Store, actor: Actor, input: EvidenceInput): WorkWrite {
  checkEvidence(input);
  return store.transaction(() => {
    const appended = store.append({
      actor,
      key: evidenceKey(input),
      kind: "work.evidence",
      payload: {
        ...input.ref,
        entry: input.entry ?? null,
        ref: input.evidenceRef ?? null,
        sha: input.sha,
        source: input.source ?? null,
        stage: input.stage,
      },
    });
    return result(store, input.ref, appended.duplicate);
  });
}

/** `work.blocked`; the same open block again is a duplicate, a changed one replaces it. */
export function blockWork(
  store: Store,
  actor: Actor,
  input: { readonly ref: WorkRef; readonly reason: string; readonly owner: string | null },
): WorkWrite {
  const ref = checkRef(input.ref);
  workText(input.reason, "invalid-reason");
  return store.transaction(() => {
    const existing = readWorkRecord(store.db, ref);
    ensure(existing?.finishedAt == null, "work-finished");
    if (existing?.block?.reason === input.reason && existing.block.owner === input.owner) {
      return { duplicate: true, record: existing };
    }
    store.append({
      actor,
      key: `work.blocked:${ref.repository}:${ref.id}:${updatedSeq(store, ref)}`,
      kind: "work.blocked",
      payload: { ...ref, blockOwner: input.owner, reason: input.reason },
    });
    return result(store, ref, false);
  });
}

/** `work.unblocked`; an item with no open block is a duplicate. */
export function unblockWork(
  store: Store,
  actor: Actor,
  input: { readonly ref: WorkRef },
): WorkWrite {
  const ref = checkRef(input.ref);
  return store.transaction(() => {
    const existing = readWorkRecord(store.db, ref);
    ensure(existing !== null, "work-unknown");
    if (existing.block === null) {
      return { duplicate: true, record: existing };
    }
    store.append({
      actor,
      key: `work.unblocked:${ref.repository}:${ref.id}:${updatedSeq(store, ref)}`,
      kind: "work.unblocked",
      payload: { ...ref },
    });
    return result(store, ref, false);
  });
}

/** `work.ready`: started, not blocked and not finished. Ready again is a duplicate. */
export function readyWork(store: Store, actor: Actor, input: { readonly ref: WorkRef }): WorkWrite {
  const ref = checkRef(input.ref);
  return store.transaction(() => {
    const existing = readWorkRecord(store.db, ref);
    ensure(existing?.startedAt != null, "work-not-started");
    ensure(existing.finishedAt === null, "work-finished");
    ensure(existing.block === null, "work-blocked");
    if (existing.readyAt !== null) {
      return { duplicate: true, record: existing };
    }
    store.append({
      actor,
      key: `work.ready:${ref.repository}:${ref.id}:${updatedSeq(store, ref)}`,
      kind: "work.ready",
      payload: { ...ref },
    });
    return result(store, ref, false);
  });
}

/** `work.finished`, once per item; it closes any open block. */
export function finishWork(
  store: Store,
  actor: Actor,
  input: { readonly ref: WorkRef; readonly owner: string },
): WorkWrite {
  const ref = checkRef(input.ref);
  return store.transaction(() => {
    const appended = store.append({
      actor,
      key: `work.finished:${ref.repository}:${ref.id}`,
      kind: "work.finished",
      payload: { ...ref, owner: input.owner },
    });
    return result(store, ref, appended.duplicate);
  });
}

export interface RetainedInput {
  readonly ref: WorkRef;
  readonly owner: string | null;
  readonly reason: string;
  readonly nextBoundary: string;
  readonly source: string;
  readonly entry: string | null;
}

export function retainedKey(input: RetainedInput): string {
  return `work.retained:${input.ref.repository}:${input.ref.id}:${sha256(
    `${input.source}\n${input.entry ?? ""}\n${input.reason}`,
  ).slice(0, 32)}`;
}

/** `work.retained`: an open item with an owner, reason and next boundary (import only). */
export function retainWorkItem(store: Store, actor: Actor, input: RetainedInput): WorkWrite {
  checkRef(input.ref);
  return store.transaction(() => {
    const appended = store.append({
      actor,
      key: retainedKey(input),
      kind: "work.retained",
      payload: {
        ...input.ref,
        entry: input.entry,
        nextBoundary: input.nextBoundary,
        owner: input.owner,
        reason: input.reason,
        source: input.source,
      },
    });
    return result(store, input.ref, appended.duplicate);
  });
}

export interface WorkHistoryEntry {
  readonly seq: number;
  readonly kind: string;
  readonly at: string;
  readonly actor: string | null;
  readonly worker: string | null;
  readonly payload: JsonObject;
}

/** Every work event of one item, in seq order. */
export function workHistory(store: Store, ref: WorkRef): WorkHistoryEntry[] {
  checkRef(ref);
  const rows = store.db
    .prepare(
      `SELECT seq FROM events WHERE kind LIKE 'work.%'
         AND json_extract(payload, '$.repository') = ? AND json_extract(payload, '$.id') = ?
       ORDER BY seq`,
    )
    .all(ref.repository, ref.id) as Row[];
  const wanted = new Set(rows.map((row) => Number(row.seq)));
  if (wanted.size === 0) {
    return [];
  }
  return store
    .events({ afterSeq: Math.min(...wanted) - 1, kinds: WORK_KINDS })
    .filter((event) => wanted.has(event.seq))
    .map((event) => ({
      actor: event.actor.role,
      at: event.at,
      kind: event.kind,
      payload: event.payload,
      seq: event.seq,
      worker: event.actor.worker ?? null,
    }));
}

/** An open hold that covers a work item, as `work start` sees it. */
export interface CoveringHold {
  readonly id: string;
  readonly owner: string | null;
  readonly policy?: PolicyHoldView["policy"];
  readonly reason: string | null;
}

/** What else a hold may cover besides the item itself: its owner role and its game. */
export interface HoldCover {
  readonly owner: string | null;
  /** The item's repository when it is a game, else null. */
  readonly game: string | null;
}

/**
 * The hold seam of `work start` and `work show`. The default is the hold records' `storeHolds`
 * (`questions.ts`); `importedHolds` reads only the imported events.
 */
export type HoldLookup = (
  store: Pick<Store, "db" | "events">,
  ref: WorkRef,
  cover?: HoldCover,
) => readonly CoveringHold[];

/** Ledger hold states that no longer hold anything; an imported hold in one is history only. */
export const CLOSED_HOLD_STATES: readonly string[] = [
  "answered",
  "cancelled",
  "cleared",
  "closed",
  "released",
  "superseded",
];

/** An imported hold is open unless its recorded state is a closed one. */
export function holdOpen(state: string | null): boolean {
  return state === null || !CLOSED_HOLD_STATES.includes(state);
}

export const importedHolds: HoldLookup = (store, ref) =>
  store
    .events({ kinds: ["hold.imported"] })
    .filter((event) => holdOpen(text(event.payload, "state")))
    .filter((event) =>
      (Array.isArray(event.payload.work) ? (event.payload.work as readonly JsonObject[]) : []).some(
        (item) => item.repository === ref.repository && item.id === ref.id,
      ),
    )
    .map((event) => ({
      id: text(event.payload, "id") ?? event.key,
      owner: text(event.payload, "owner"),
      reason: text(event.payload, "reason"),
    }));
