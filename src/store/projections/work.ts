// Work records, their stage evidence and their retained items.
import { payloadText as text } from "../eventCodec.ts";
import type { ProjectionIndex, ProjectionRow } from "../projectionIndex.ts";
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

function touch(index: ProjectionIndex, event: StoredEvent, changes: ProjectionRow = {}): void {
  const repository = text(event.payload, "repository");
  const id = text(event.payload, "id");
  const key = [repository, id];
  const row: ProjectionRow = {
    block: null,
    finished_at: null,
    id,
    owner: null,
    parent_id: null,
    parent_repository: null,
    ready_at: null,
    repository,
    started_at: null,
    ...index.get("work", key),
    ...changes,
    updated_at: event.at,
    updated_seq: event.seq,
  };
  const state =
    row.finished_at != null
      ? "finished"
      : row.block != null
        ? "blocked"
        : row.ready_at != null
          ? "ready"
          : row.started_at != null
            ? "started"
            : "recorded";
  index.put("work", key, { ...row, state });
}

function parentOf(payload: JsonObject): { repository: string | null; id: string | null } {
  const parent = payload.parent;
  if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
    return { id: null, repository: null };
  }
  const value = parent as JsonObject;
  return { id: text(value, "id"), repository: text(value, "repository") };
}

const started = (index: ProjectionIndex, event: StoredEvent): void => {
  const parent = parentOf(event.payload);
  touch(index, event, {
    owner: text(event.payload, "owner"),
    parent_id: parent.id,
    parent_repository: parent.repository,
    started_at: event.at,
  });
};

const evidence = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  index.put("work_evidence", [event.seq], {
    actor: event.actor.role,
    at: event.at,
    entry: text(p, "entry"),
    id: text(p, "id"),
    ref: text(p, "ref"),
    repository: text(p, "repository"),
    seq: event.seq,
    sha: text(p, "sha"),
    source: text(p, "source"),
    stage: text(p, "stage"),
  });
  touch(index, event);
};

const blocked = (index: ProjectionIndex, event: StoredEvent): void => {
  touch(index, event, {
    block: JSON.stringify({
      at: event.at,
      owner: text(event.payload, "blockOwner"),
      reason: text(event.payload, "reason"),
    }),
  });
};

const finished = (index: ProjectionIndex, event: StoredEvent): void => {
  const owner = text(event.payload, "owner");
  touch(index, event, { block: null, finished_at: event.at, ...(owner === null ? {} : { owner }) });
};

const retainedItem = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  index.put("work_retained", [event.seq], {
    at: event.at,
    entry: text(p, "entry"),
    id: text(p, "id"),
    next_boundary: text(p, "nextBoundary"),
    owner: text(p, "owner"),
    reason: text(p, "reason"),
    repository: text(p, "repository"),
    seq: event.seq,
    source: text(p, "source"),
  });
  touch(index, event);
};

/** Work records, their stage evidence and their retained items. */
export const WORK_PROJECTION: Projection = {
  apply: {
    "work.blocked": blocked,
    "work.evidence": evidence,
    "work.finished": finished,
    "work.ready": (index, event) => touch(index, event, { ready_at: event.at }),
    "work.retained": retainedItem,
    "work.started": started,
    "work.unblocked": (index, event) => touch(index, event, { block: null }),
  },
  tables: ["work", "work_evidence", "work_retained"],
};
