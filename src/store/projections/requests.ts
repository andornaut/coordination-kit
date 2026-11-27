// Requests imported from the retired request ledger and their closes.
import { payloadText as text } from "../eventCodec.ts";
import type { ProjectionIndex } from "../projectionIndex.ts";
import type { JsonObject, Projection, StoredEvent } from "../types.ts";

const imported = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const id = text(p, "id");
  const source = (p.source ?? {}) as JsonObject;
  if (index.get("requests", [id]) === undefined) {
    index.put("requests", [id], {
      close_reason: null,
      close_work: null,
      closed_at: null,
      id,
      imported_at: event.at,
      imported_seq: event.seq,
      kind: text(p, "kind") ?? "request",
      owner: text(p, "owner"),
      question: text(p, "question"),
      reason: text(p, "reason"),
      required_owner: text(p, "requiredOwner"),
      source_origin: text(source, "origin"),
      source_reference: text(source, "reference"),
      state: text(p, "state") ?? "open",
      summary: text(p, "summary") ?? "",
      updated_at: text(p, "updatedAt") ?? event.at,
      work: JSON.stringify(Array.isArray(p.work) ? p.work : []),
    });
  }
};

const closed = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const key = [text(p, "id")];
  const previous = index.get("requests", key);
  if (previous !== undefined) {
    index.put("requests", key, {
      ...previous,
      close_reason: text(p, "reason"),
      close_work: text(p, "work"),
      closed_at: event.at,
    });
  }
};

export const REQUESTS_PROJECTION: Projection = {
  apply: { "request.closed": closed, "request.imported": imported },
  tables: ["requests"],
};
