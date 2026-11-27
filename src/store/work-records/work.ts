// Work records over the store: start, stage evidence, block, ready and finish for each approved
// work item, keyed by (repository, work ID). Approval, owner and scope stay in the work file on the
// repository's `main`; the store holds only live progress. Every function trusts its `actor`: the
// CLI applies the registry fence and the repository owner check first (src/work/live.ts).
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { Store } from "../db.ts";
import { payloadText as text, sha256 } from "../eventCodec.ts";
import { WORK_KINDS } from "../projections/work.ts";
import { secretShape } from "../secrets.ts";
import { type Actor, ensure, type JsonObject, type WorkRef } from "../types.ts";

export const WORK_STAGES = ["implemented", "merged", "verified", "published", "deployed"] as const;
export type WorkStage = (typeof WORK_STAGES)[number];
export type WorkState = "recorded" | "started" | "blocked" | "ready" | "finished";
/** The work file statuses `work finish` accepts; a finish without a recorded status is `done`. */
export const FINISH_STATUSES = ["done", "superseded", "cancelled"] as const;
export type FinishStatus = (typeof FINISH_STATUSES)[number];
/** `<prefix>-` and a zero-padded sequence, as in the work-file convention. */
export const WORK_ID = /^[a-z][a-z0-9]*-\d{4,}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A Git object name: abbreviated (7 or more) up to a full SHA-1 or SHA-256, lower case. */
export const SHA = /^[0-9a-f]{7,64}$/;
const MAX_TEXT = 2000;

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

interface WorkRetained {
  readonly owner: string | null;
  readonly reason: string;
  readonly nextBoundary: string;
  readonly source: string | null;
  readonly entry: string | null;
  readonly at: string;
}

interface WorkBlock {
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
  /** The work file status the finish recorded; null until finished. */
  readonly finishedStatus: FinishStatus | null;
  /** The successor IDs a superseded finish cites, in ID order; empty otherwise. */
  readonly successors: readonly string[];
  readonly block: WorkBlock | null;
  readonly evidence: readonly WorkEvidence[];
  readonly retained: readonly WorkRetained[];
  readonly updatedAt: string;
}

type Row = Record<string, SQLInputValue>;

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

function workRow(db: DatabaseSync, ref: WorkRef): Row | undefined {
  return db
    .prepare("SELECT * FROM work WHERE repository = ? AND id = ?")
    .get(ref.repository, ref.id) as Row | undefined;
}

const nullable = (row: Row, key: string): string | null => (row[key] as string | null) ?? null;

function finishKey(ref: WorkRef): string {
  return `work.finished:${ref.repository}:${ref.id}`;
}

/** The status and successors a finish event records; a payload without `status` is `done`. */
function finishOutcome(
  db: DatabaseSync,
  ref: WorkRef,
): Pick<WorkRecord, "finishedStatus" | "successors"> {
  const row = db.prepare("SELECT payload FROM events WHERE key = ?").get(finishKey(ref)) as
    Row | undefined;
  if (row === undefined) {
    return { finishedStatus: "done", successors: [] };
  }
  const payload = JSON.parse(row.payload as string) as JsonObject;
  const status = text(payload, "status") ?? "done";
  const successors = Array.isArray(payload.successors) ? payload.successors : [];
  return {
    finishedStatus: (FINISH_STATUSES as readonly string[]).includes(status)
      ? (status as FinishStatus)
      : "done",
    successors: successors.filter((id): id is string => typeof id === "string"),
  };
}

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
  const finishedAt = nullable(row, "finished_at");
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
    finishedAt,
    ...(finishedAt === null ? { finishedStatus: null, successors: [] } : finishOutcome(db, ref)),
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

function checkEvidence(input: EvidenceInput): EvidenceInput {
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

export interface FinishInput {
  readonly ref: WorkRef;
  readonly owner: string;
  /** The work file status; `done` when omitted. */
  readonly status?: FinishStatus;
  /** The work items that supersede this one; required, and only allowed, for `superseded`. */
  readonly successors?: readonly string[];
}

/**
 * `work.finished`, once per item; it closes any open block. A `done` finish records
 * `{repository, id, owner}`; `superseded` adds `status` and the sorted `successors`, and
 * `cancelled` adds `status`.
 */
export function finishWork(store: Store, actor: Actor, input: FinishInput): WorkWrite {
  const ref = checkRef(input.ref);
  const status = input.status ?? "done";
  ensure((FINISH_STATUSES as readonly string[]).includes(status), "invalid-finish-status");
  const successors = [...new Set(input.successors ?? [])].sort();
  if (status === "superseded") {
    ensure(successors.length > 0, "successor-missing");
  } else {
    ensure(successors.length === 0, "invalid-successor");
  }
  ensure(
    successors.every((id) => WORK_ID.test(id) && id !== ref.id),
    "invalid-successor",
  );
  return store.transaction(() => {
    const appended = store.append({
      actor,
      key: finishKey(ref),
      kind: "work.finished",
      payload: {
        ...ref,
        owner: input.owner,
        ...(status === "done" ? {} : { status }),
        ...(status === "superseded" ? { successors } : {}),
      },
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
