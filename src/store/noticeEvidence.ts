// Native notice reconciliation uses exact consumption or accepted queue absence with collection.
import { join } from "node:path";

import { queueEntries, type QueueEntry } from "../adapters/codex/inventory.ts";
import { rootRecipient } from "../adapters/codex/queue.ts";
import type { RpcClient } from "../adapters/codex/rpc.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import { readJsonIfExists } from "../durable.ts";
import { type NoticeBinding, noticeText, type PendingNotice } from "./noticesInFlight.ts";

const PAGES = 10;
const MAX_PAGE_SIZE = 100;
const REFERENCE = /^[A-Za-z0-9_.:-]{1,128}$/;
const NOTICE = /^\d+ new messages for ([^ :]+): run coordination-kit inbox(?: \[[a-f0-9-]+\])?$/;

function plainText(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 1) {
    return null;
  }
  const item: unknown = value[0];
  return isRecord(item) &&
    item.type === "text" &&
    typeof item.text === "string" &&
    Object.keys(item).every((key) => ["type", "text", "text_elements"].includes(key)) &&
    (item.text_elements === undefined ||
      (Array.isArray(item.text_elements) && item.text_elements.length === 0))
    ? item.text
    : null;
}

function queueNotice(entry: QueueEntry, role: string): boolean {
  return entry.input.some(
    (item) =>
      isRecord(item) &&
      item.type === "text" &&
      typeof item.text === "string" &&
      NOTICE.exec(item.text)?.[1] === role,
  );
}

export async function noticeQueueClear(
  client: RpcClient,
  binding: NoticeBinding,
): Promise<boolean> {
  try {
    return !(await queueEntries(client, binding.conversation, PAGES)).some((entry) =>
      queueNotice(entry, binding.role),
    );
  } catch {
    return false;
  }
}

interface ConsumptionProof {
  readonly kind: "consumed";
  readonly notice: PendingNotice;
  readonly item: string;
  readonly turn: string;
}

interface CollectionProof {
  readonly kind: "released";
  readonly notice: PendingNotice;
  readonly inboxReads: readonly number[];
  readonly queueId: string;
}

export type NoticeProof = ConsumptionProof | CollectionProof;

interface Reconciliation {
  readonly notice: PendingNotice;
  readonly queueId: string | null;
  readonly text: string;
}

function receiptEvidence(root: string, notice: PendingNotice): Reconciliation | null {
  if (!notice.readyForProof || !isCanonicalUuid(notice.id)) {
    return null;
  }
  if (notice.origin === "reminder") {
    return { notice, queueId: null, text: noticeText(notice.count, notice.role, notice.id) };
  }
  const text = noticeText(notice.count, notice.role);
  let receipt: unknown;
  try {
    receipt = readJsonIfExists(join(root, "wake", "codex", `${notice.id}.json`));
  } catch {
    return null;
  }
  if (
    !isRecord(receipt) ||
    receipt.recipient !== notice.conversation ||
    receipt.clientUserMessageId !== notice.id ||
    receipt.text !== text
  ) {
    return null;
  }
  if (
    receipt.status === "accepted" &&
    typeof receipt.queueId === "string" &&
    receipt.queueId !== ""
  ) {
    return { notice, queueId: receipt.queueId, text };
  }
  return receipt.status === "sending" || receipt.status === "ambiguous"
    ? { notice, queueId: null, text }
    : null;
}

function historyProofs(
  data: readonly unknown[],
  recipient: string,
  pending: ReadonlyMap<string, Reconciliation>,
): ConsumptionProof[] {
  const proofs: ConsumptionProof[] = [];
  for (const entry of data) {
    if (!isRecord(entry) || (entry.threadId !== undefined && entry.threadId !== recipient)) {
      throw new Error("native history binding unavailable");
    }
    const item = entry.item;
    if (!isRecord(item) || item.type !== "userMessage") {
      continue;
    }
    const content = plainText(item.content);
    if (
      content === null ||
      typeof item.id !== "string" ||
      !REFERENCE.test(item.id) ||
      typeof entry.turnId !== "string" ||
      !REFERENCE.test(entry.turnId)
    ) {
      continue;
    }
    const row = typeof item.clientId === "string" ? pending.get(item.clientId) : undefined;
    if (row?.notice.origin === "wake" && content === row.text) {
      proofs.push({ item: item.id, kind: "consumed", notice: row.notice, turn: entry.turnId });
      continue;
    }
    const suffix = / \[([a-f0-9-]{36})\]$/.exec(content)?.[1];
    const fallback = suffix === undefined ? undefined : pending.get(suffix);
    if (fallback?.notice.origin === "reminder" && content === fallback.text) {
      proofs.push({ item: item.id, kind: "consumed", notice: fallback.notice, turn: entry.turnId });
    }
  }
  return proofs;
}

export async function reconcileNativeNotices(
  client: RpcClient,
  root: string,
  binding: NoticeBinding,
  notices: readonly PendingNotice[],
  collected: ReadonlyMap<string, readonly number[]>,
  canRelease: (client: RpcClient) => Promise<boolean>,
): Promise<NoticeProof[]> {
  // A claim that is not yet visibly in-flight supplies no reconciliation evidence.
  const candidates = notices.flatMap((notice) => receiptEvidence(root, notice) ?? []);
  if (candidates.length === 0) {
    return [];
  }
  let released: CollectionProof[] = [];
  try {
    const { conversation, role } = binding;
    if (!(await rootRecipient(client, conversation))) {
      return [];
    }
    const queue = await queueEntries(client, conversation, PAGES);
    const pending = new Map(
      candidates
        .filter(
          ({ notice, queueId, text }) =>
            !queue.some(
              (entry) =>
                entry.id === queueId ||
                entry.clientUserMessageId === notice.id ||
                (queueNotice(entry, role) && plainText(entry.input) === text),
            ),
        )
        .map((value) => [value.notice.id, value] as const),
    );
    if (queue.length === 0) {
      const ready = candidates.flatMap(({ notice, queueId }): CollectionProof[] => {
        const inboxReads = collected.get(notice.id);
        return inboxReads === undefined || queueId === null || !REFERENCE.test(queueId)
          ? []
          : [{ inboxReads, kind: "released", notice, queueId }];
      });
      if (
        ready.length > 0 &&
        (await canRelease(client)) &&
        (await queueEntries(client, conversation, PAGES)).length === 0
      ) {
        released = ready;
        for (const proof of released) {
          pending.delete(proof.notice.id);
        }
      }
    }
    const consumed: ConsumptionProof[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < PAGES && pending.size > 0; page += 1) {
      // Pages depend on the preceding cursor.
      // eslint-disable-next-line no-await-in-loop
      const response = await client.call("thread/items/list", {
        ...(cursor === undefined ? {} : { cursor }),
        limit: MAX_PAGE_SIZE,
        sortDirection: "desc",
        threadId: conversation,
      });
      if (
        !isRecord(response) ||
        !Array.isArray(response.data) ||
        response.data.length > MAX_PAGE_SIZE ||
        response.truncated ||
        response.hasMore
      ) {
        return released;
      }
      for (const proof of historyProofs(response.data, conversation, pending)) {
        if (pending.delete(proof.notice.id)) {
          consumed.push(proof);
        }
      }
      const next = response.nextCursor;
      if (next == null || pending.size === 0) {
        return [...released, ...consumed];
      }
      if (typeof next !== "string" || !next || cursors.has(next)) {
        return released;
      }
      cursors.add(next);
      cursor = next;
    }
    return [...released, ...consumed];
  } catch {
    return released;
  }
}
