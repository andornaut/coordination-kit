import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { type JsonObject, STORE_SCHEMA, type StoredEvent, StoreError } from "./types.ts";

type Row = Record<string, SQLInputValue>;

/** JSON with object keys sorted at every depth and no whitespace; the hash input form. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StoreError("invalid-payload");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new StoreError("invalid-payload");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 over the previous hash and the canonical event, so any edit breaks every later link. */
export function eventHash(event: Omit<StoredEvent, "hash">): string {
  return sha256(
    `${event.prevHash}\n${canonicalJson({
      actor: { nativeId: event.actor.nativeId, role: event.actor.role, worker: event.actor.worker },
      at: event.at,
      key: event.key,
      kind: event.kind,
      payload: event.payload,
      schema: STORE_SCHEMA,
      seq: event.seq,
    })}`,
  );
}

export function rowEvent(row: Row): StoredEvent {
  const worker = row.actor_worker;
  return {
    actor: {
      nativeId: (row.actor_native_id as string | null) ?? null,
      role: (row.actor_role as string | null) ?? null,
      ...(typeof worker === "string" ? { worker } : {}),
    },
    at: row.at as string,
    hash: row.hash as string,
    key: row.key as string,
    kind: row.kind as string,
    payload: JSON.parse(row.payload as string) as JsonObject,
    prevHash: row.prev_hash as string,
    seq: Number(row.seq),
  };
}

export function latestStoreReview(
  index: DatabaseSync,
  throughSeq = Number.MAX_SAFE_INTEGER,
): StoredEvent | undefined {
  const row = index
    .prepare(
      "SELECT * FROM events WHERE kind = 'review.brief' AND seq <= ? ORDER BY seq DESC LIMIT 1",
    )
    .get(throughSeq) as Row | undefined;
  return row === undefined ? undefined : rowEvent(row);
}
