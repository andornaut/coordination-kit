// Native queue inventory (thread/queue/list) and the native half of an explicit acknowledgement
// (thread/queue/delete).
import { dumpsJson, isRecord, type PyJson, sameJson } from "../shared/pyjson.ts";
import type { RpcClient } from "./rpc.ts";

export interface QueueEntry {
  readonly id: string;
  readonly clientUserMessageId: string;
  readonly input: readonly PyJson[];
  readonly [key: string]: unknown;
}

function queuePage(page: unknown, entries: Map<string, QueueEntry>): unknown {
  if (
    !isRecord(page) ||
    !Array.isArray(page.data) ||
    page.data.length > 100 ||
    page.truncated ||
    page.hasMore
  ) {
    throw new Error("queue inventory incomplete");
  }
  for (const entry of page.data as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id === "" ||
      typeof entry.clientUserMessageId !== "string" ||
      !Array.isArray(entry.input)
    ) {
      throw new Error("unknown queued submission shape");
    }
    const known = entries.get(entry.id);
    const same = known === undefined || sameJson(known, entry);
    if (!same) {
      throw new Error("queue changed during pagination");
    }
    entries.set(entry.id, entry as unknown as QueueEntry);
  }
  return page.nextCursor ?? null;
}

/** Every queued submission for `recipient`, failing on any incomplete or inconsistent page. */
export async function queueEntries(
  client: RpcClient,
  recipient: string,
  maxPages = Infinity,
): Promise<QueueEntry[]> {
  const entries = new Map<string, QueueEntry>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params: Record<string, unknown> = { limit: 100, threadId: recipient };
    if (cursor !== null) {
      params.cursor = cursor;
    }
    // Pages follow their cursor in order.
    // eslint-disable-next-line no-await-in-loop
    const next = queuePage(await client.call("thread/queue/list", params), entries);
    if (next === null) {
      return [...entries.values()];
    }
    if (typeof next !== "string" || next === "" || cursors.has(next)) {
      throw new Error("queue pagination did not advance");
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error("queue inventory bound exceeded");
}

/**
 * The inventory payload: the text of a single plain text input, which with the client message ID
 * rebuilds the exact payload signature input; any other input shape as its Python JSON form.
 */
export function queuePayload(entry: QueueEntry): string {
  const [first, ...rest] = entry.input;
  if (
    rest.length === 0 &&
    isRecord(first) &&
    first.type === "text" &&
    typeof first.text === "string" &&
    Object.keys(first).length === 2
  ) {
    return first.text;
  }
  return dumpsJson(entry.input);
}

export type AckOutcome =
  | "ambiguous"
  | "changed_payload"
  | "confirmed_absent"
  | "deleted"
  | "not_deleted"
  | "retained"
  | "unavailable";

async function absentAfter(
  client: RpcClient,
  recipient: string,
  queueId: string,
): Promise<boolean> {
  const after = await queueEntries(client, recipient);
  return !after.some((entry) => entry.id === queueId);
}

/**
 * The native part of acknowledging one queued submission. Every call re-lists first. A changed
 * payload is never deleted; `retained` leaves the native queue untouched.
 */
export async function acknowledgeEntry(
  client: RpcClient,
  beforeDelete: (() => Promise<void>) | undefined,
  recipient: string,
  queueId: string,
  payload: string,
  disposition: "handled" | "retained" | "superseded",
): Promise<AckOutcome> {
  let current: QueueEntry | undefined;
  try {
    current = (await queueEntries(client, recipient)).find((entry) => entry.id === queueId);
  } catch {
    return "unavailable";
  }
  if (current === undefined) {
    return "confirmed_absent";
  }
  if (queuePayload(current) !== payload) {
    return "changed_payload";
  }
  if (disposition === "retained") {
    return "retained";
  }
  // A refused guard precedes deletion and is never reconciled as an attempted deletion.
  if (beforeDelete !== undefined) {
    try {
      await beforeDelete();
    } catch {
      return "unavailable";
    }
  }
  try {
    const response = await client.call("thread/queue/delete", {
      queuedSubmissionId: queueId,
      threadId: recipient,
    });
    if (!isRecord(response) || typeof response.deleted !== "boolean") {
      throw new Error("unknown deletion response");
    }
    if (response.deleted) {
      return "deleted";
    }
    return (await absentAfter(client, recipient, queueId)) ? "confirmed_absent" : "not_deleted";
  } catch {
    try {
      return (await absentAfter(client, recipient, queueId)) ? "confirmed_absent" : "ambiguous";
    } catch {
      return "ambiguous";
    }
  }
}
