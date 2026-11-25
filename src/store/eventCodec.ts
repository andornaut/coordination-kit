// The canonical forms events are stored, hashed and compared in: canonical JSON, the chained event
// hash, normalized link sets and the events row codec.
import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  ensure,
  type JsonObject,
  type MessageLink,
  STORE_SCHEMA,
  type StoredEvent,
  StoreError,
} from "./types.ts";

type Row = Record<string, SQLInputValue>;

/** A link or record reference: one token of at most 512 characters. */
export const REF = /^[A-Za-z0-9][A-Za-z0-9._:/#@+-]{0,511}$/;
const LINK_KIND = /^[a-z][a-z0-9-]{0,31}$/;

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

/** Lower-case hex sha256 of `value`; a string is hashed as UTF-8. */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A payload member when it is a string, else null. */
export function payloadText(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/** A payload member as JSON text, null when absent. */
export function payloadJson(payload: JsonObject, key: string): string {
  return JSON.stringify(payload[key] ?? null);
}

/** Links sorted by kind then ref, without duplicates, so equal sets compare equal. */
export function normalizeLinks(links: readonly MessageLink[]): MessageLink[] {
  const seen = new Map<string, MessageLink>();
  for (const link of links) {
    ensure(LINK_KIND.test(link.kind) && REF.test(link.ref), "invalid-link");
    seen.set(`${link.kind}=${link.ref}`, { kind: link.kind, ref: link.ref });
  }
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, link]) => link);
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
