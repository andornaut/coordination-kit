// Canonical JSON, chained event hashes and normalized link sets.
import { createHash } from "node:crypto";

import type { Store } from "./db.ts";
import {
  ensure,
  type JsonObject,
  type MessageLink,
  STORE_SCHEMA,
  type StoredEvent,
  StoreError,
} from "./types.ts";

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

export function latestStoreReview(
  history: Pick<Store, "events">,
  throughSeq = Number.MAX_SAFE_INTEGER,
): StoredEvent | undefined {
  return history.events({ kinds: ["review.brief"] }).findLast(({ seq }) => seq <= throughSeq);
}
