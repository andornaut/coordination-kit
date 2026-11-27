// Requests imported from the retired request ledger (`store retire`). Each open ledger request is
// one `request.imported` record owned by its role; `status` lists it as `requested` until its owner
// maps it to a work file or closes it with `request close`, which only that owner can do.
import type { Store } from "../db.ts";
import type { ProjectionIndex, ProjectionRow } from "../projectionIndex.ts";
import { secretShape } from "../secrets.ts";
import { type Actor, ensure, type Json } from "../types.ts";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface RequestRecord {
  readonly id: string;
  readonly owner: string;
  readonly kind: string;
  readonly summary: string;
  /** The ledger state at import: open, started, blocked, waiting, ready, checked, ... */
  readonly state: string;
  /** The ledger question status (`pending`, `answered`, ...), or null without a question. */
  readonly question: string | null;
  readonly source: { readonly origin: string | null; readonly reference: string | null };
  /** Work IDs the request names. */
  readonly work: readonly string[];
  readonly reason: string | null;
  readonly requiredOwner: string | null;
  /** The ledger's last update before import. */
  readonly updatedAt: string;
  readonly importedAt: string;
  readonly closed: {
    readonly at: string;
    readonly reason: string;
    readonly work: string | null;
  } | null;
}

/** The `request.imported` payload: one open ledger request. */
export type RequestImport = Omit<RequestRecord, "closed" | "importedAt">;

type Row = ProjectionRow;

function view(row: Row): RequestRecord {
  const string = (key: string): string | null => (row[key] as string | null) ?? null;
  return {
    closed:
      row.closed_at === null
        ? null
        : {
            at: row.closed_at as string,
            reason: row.close_reason as string,
            work: string("close_work"),
          },
    id: row.id as string,
    importedAt: row.imported_at as string,
    kind: row.kind as string,
    owner: row.owner as string,
    question: string("question"),
    reason: string("reason"),
    requiredOwner: string("required_owner"),
    source: { origin: string("source_origin"), reference: string("source_reference") },
    state: row.state as string,
    summary: row.summary as string,
    updatedAt: row.updated_at as string,
    work: JSON.parse(row.work as string) as string[],
  };
}

/** Every imported request in import order. */
export function readRequests(index: ProjectionIndex): RequestRecord[] {
  return [...index.rows("requests")]
    .sort((a, b) => Number(a.imported_seq) - Number(b.imported_seq))
    .map(view);
}

function readRequest(store: Store, id: string): RequestRecord | undefined {
  const row = store.index.get("requests", [id]);
  return row === undefined ? undefined : view(row);
}

/** The `request.imported` event for one open ledger request; a repeat is a no-op. */
export function importRequest(store: Store, actor: Actor, request: RequestImport): boolean {
  ensure(REQUEST_ID.test(request.id), "invalid-request");
  const payload: { [key: string]: Json } = {
    id: request.id,
    kind: request.kind,
    owner: request.owner,
    question: request.question,
    reason: request.reason,
    requiredOwner: request.requiredOwner,
    source: { origin: request.source.origin, reference: request.source.reference },
    state: request.state,
    summary: request.summary,
    updatedAt: request.updatedAt,
    work: [...request.work],
  };
  return !store.append({
    actor,
    key: `request.imported:${request.id}`,
    kind: "request.imported",
    payload,
  }).duplicate;
}

export interface CloseRequestResult {
  readonly duplicate: boolean;
  readonly request: RequestRecord;
}

/**
 * Close the caller's own imported request with a reason and, optionally, the work item that now
 * carries it. Only its owner can (`not-owner`); repeating the same close is a no-op.
 */
export function closeRequest(
  store: Store,
  actor: Actor,
  input: { readonly id: string; readonly reason: string; readonly work?: string },
): CloseRequestResult {
  ensure(actor.role !== null, "invalid-actor");
  ensure(REQUEST_ID.test(input.id), "invalid-id");
  ensure(
    input.reason.trim() !== "" && input.reason.length <= 1000 && !/[\r\n]/.test(input.reason),
    "invalid-reason",
  );
  ensure(secretShape(input.reason) === null, "secret-shaped-text");
  ensure(input.work === undefined || WORK_ID.test(input.work), "invalid-work");
  const work = input.work ?? null;
  return store.transaction(() => {
    const existing = readRequest(store, input.id);
    ensure(existing !== undefined, "missing");
    ensure(existing.owner === actor.role, "not-owner");
    if (existing.closed !== null) {
      ensure(
        existing.closed.reason === input.reason && existing.closed.work === work,
        "already-closed",
      );
      return { duplicate: true, request: existing };
    }
    store.append({
      actor,
      key: `request.closed:${input.id}`,
      kind: "request.closed",
      payload: { id: input.id, reason: input.reason, work },
    });
    return { duplicate: false, request: readRequest(store, input.id)! };
  });
}
