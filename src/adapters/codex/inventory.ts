// Native queue inventory (thread/queue/list).
import { isRecord, type PyJson, sameJson } from "../../core/pyjson.ts";
import type { RpcClient } from "./rpc.ts";

export interface QueueEntry {
  readonly id: string;
  readonly clientUserMessageId: string;
  readonly input: readonly PyJson[];
  readonly [key: string]: unknown;
}

export class QueueInventoryError extends Error {
  readonly reason: "incomplete" | "pagination-unverified";

  constructor(reason: QueueInventoryError["reason"], message: string) {
    super(message);
    this.name = "QueueInventoryError";
    this.reason = reason;
  }
}

function queuePage(page: unknown, entries: Map<string, QueueEntry>): unknown {
  if (
    !isRecord(page) ||
    !Array.isArray(page.data) ||
    page.data.length > 100 ||
    page.truncated ||
    page.hasMore
  ) {
    throw new QueueInventoryError("incomplete", "queue inventory incomplete");
  }
  for (const entry of page.data as unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id === "" ||
      typeof entry.clientUserMessageId !== "string" ||
      !Array.isArray(entry.input)
    ) {
      throw new QueueInventoryError("incomplete", "unknown queued submission shape");
    }
    const known = entries.get(entry.id);
    const same = known === undefined || sameJson(known, entry);
    if (!same) {
      throw new QueueInventoryError("pagination-unverified", "queue changed during pagination");
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
      throw new QueueInventoryError("pagination-unverified", "queue pagination did not advance");
    }
    cursors.add(next);
    cursor = next;
  }
  throw new QueueInventoryError("pagination-unverified", "queue inventory bound exceeded");
}
