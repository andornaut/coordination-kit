// Recipient decision guard: a recipient-bound clearance record, verified against native question
// history by exact turn and item IDs. Unknown or incomplete history defers.
import { decisionClear, type DecisionRecord, decisionRecord } from "../shared/decisions.ts";
import { isCanonicalUuid } from "../shared/ids.ts";
import { isRecord, sameJson } from "../shared/pyjson.ts";
import { type NativeQuestionRef, safeNativeQuestionRef } from "../types.ts";
import type { RpcClient } from "./rpc.ts";

export const NATIVE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "agentMessage",
  "collabAgentToolCall",
  "commandExecution",
  "contextCompaction",
  "dynamicToolCall",
  "enteredReviewMode",
  "exitedReviewMode",
  "fileChange",
  "functionCallOutput",
  "hookPrompt",
  "imageGeneration",
  "imageView",
  "mcpToolCall",
  "plan",
  "reasoning",
  "sleep",
  "subAgentActivity",
  "userMessage",
  "webSearch",
]);

const QUESTION_TOOLS = ["requestuserinput", "askuserquestion", "elicitation"];
const MAX_ITEM_PAGES = 64;
const MAX_PROOF_TURNS = 8;
const REPLY_OPEN = "<send_user_message_question_reply>\n";
const REPLY_CLOSE = "\n</send_user_message_question_reply>";
const ITEM_TIMESTAMPS: readonly string[] = ["completedAtMs", "startedAtMs"];

export type NativeItem = Record<string, unknown> & { readonly id: string; readonly type: string };

export interface NativeQuestionDiagnostic {
  readonly stage: "question-guard";
  readonly category:
    | "decision-clearance"
    | "pending-question"
    | "question-resolution"
    | "history-unavailable"
    | "compaction-unproven"
    | "binding-mismatch";
  readonly classification: "guarded" | "unavailable";
  readonly question?: NativeQuestionRef;
}

type QuestionResult = [boolean, string | null, NativeQuestionDiagnostic?];

function refusedQuestion(
  diagnostic: Omit<NativeQuestionDiagnostic, "stage">,
  reason: string,
  include: boolean,
): QuestionResult {
  return include ? [false, reason, { ...diagnostic, stage: "question-guard" }] : [false, reason];
}

export interface Resolution {
  readonly question_turn_id: string;
  readonly question_item_id: string;
  readonly answer_turn_id: string;
  readonly answer_item_id: string;
}

/** True while the clearance read before a send still matches the current record. */
export function clearanceUnchanged(
  unblockDir: string,
  recipient: string,
  clearance: DecisionRecord | null,
): boolean {
  return (
    decisionClear(unblockDir, recipient) &&
    sameJson(decisionRecord(unblockDir, recipient), clearance)
  );
}

function pyStr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  return String(value);
}

/** A rendered prompt or a question tool call. */
export function questionItem(item: Record<string, unknown>): boolean {
  if (item.type === "agentMessage") {
    // Omitted questions default to null in the native schema.
    const questions = item.questions;
    return !(questions == null || (Array.isArray(questions) && questions.length === 0));
  }
  if (item.type === "dynamicToolCall" || item.type === "functionCallOutput") {
    let tool = "";
    if ("tool" in item) {
      tool = pyStr(item.tool);
    } else if ("name" in item) {
      tool = pyStr(item.name);
    }
    const normalized = tool.toLowerCase().replaceAll("_", "");
    return QUESTION_TOOLS.some((name) => normalized.includes(name));
  }
  return false;
}

/** Optional native int64 metadata is nullable and must be exactly representable in JavaScript. */
function nativeTimestamps(record: Record<string, unknown>): boolean {
  return ITEM_TIMESTAMPS.every(
    (key) =>
      !Object.hasOwn(record, key) || record[key] === null || Number.isSafeInteger(record[key]),
  );
}

function itemPage(
  page: unknown,
  recipient: string,
  turnId: string,
  items: Map<string, NativeItem>,
): unknown {
  if (!isRecord(page) || !Array.isArray(page.data) || page.truncated || page.hasMore) {
    throw new Error("native item history incomplete");
  }
  for (const entry of page.data as unknown[]) {
    if (
      !isRecord(entry) ||
      entry.turnId !== turnId ||
      !nativeTimestamps(entry) ||
      (Object.hasOwn(entry, "threadId") && entry.threadId !== recipient) ||
      (Object.hasOwn(entry, "outputDeferred") && entry.outputDeferred !== false)
    ) {
      throw new Error("native turn identity mismatch");
    }
    const item = entry.item;
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id === "" ||
      typeof item.type !== "string" ||
      !NATIVE_ITEM_TYPES.has(item.type)
    ) {
      throw new Error("unknown native item");
    }
    if (item.type === "mcpToolCall" && item.status !== "completed") {
      throw new Error("native tool incomplete");
    }
    if (items.has(item.id)) {
      throw new Error("duplicate native item");
    }
    items.set(item.id, item as NativeItem);
  }
  return page.nextCursor ?? null;
}

/** Every item of one turn in native order, failing on any incomplete or unknown page. */
export async function nativeItems(
  client: RpcClient,
  recipient: string,
  turnId: string,
): Promise<Map<string, NativeItem>> {
  const items = new Map<string, NativeItem>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_ITEM_PAGES; page += 1) {
    const params: Record<string, unknown> = {
      limit: 100,
      sortDirection: "asc",
      threadId: recipient,
      turnId,
    };
    if (cursor !== null) {
      params.cursor = cursor;
    }
    // Pages follow their cursor in order.
    // eslint-disable-next-line no-await-in-loop
    const next = itemPage(await client.call("thread/items/list", params), recipient, turnId, items);
    if (next === null) {
      return items;
    }
    if (typeof next !== "string" || next === "" || cursors.has(next)) {
      throw new Error("native pagination incomplete");
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error("native item history page bound reached");
}

async function itemsFor(
  client: RpcClient,
  pages: Map<string, Map<string, NativeItem>>,
  recipient: string,
  turnId: string,
): Promise<Map<string, NativeItem>> {
  const known = pages.get(turnId);
  if (known !== undefined) {
    return known;
  }
  const items = await nativeItems(client, recipient, turnId);
  pages.set(turnId, items);
  return items;
}

interface CompletedTurn {
  readonly id: string;
}

function completedTurn(page: unknown): { readonly turn: CompletedTurn; readonly next: unknown } {
  if (
    !isRecord(page) ||
    !Array.isArray(page.data) ||
    page.data.length !== 1 ||
    page.truncated ||
    page.hasMore
  ) {
    throw new Error("native turn history incomplete");
  }
  const turn: unknown = page.data[0];
  if (
    !isRecord(turn) ||
    typeof turn.id !== "string" ||
    turn.id === "" ||
    turn.status !== "completed" ||
    turn.error != null
  ) {
    throw new Error("native question proof requires a completed turn");
  }
  return { next: page.nextCursor ?? null, turn: { id: turn.id } };
}

/** Only a completed, single-item compaction turn may inherit its preceding question proof. */
async function precedingQuestionTurn(
  client: RpcClient,
  pages: Map<string, Map<string, NativeItem>>,
  recipient: string,
  latestId: string,
): Promise<string> {
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let index = 0; index < MAX_PROOF_TURNS; index += 1) {
    // Pages follow their native cursor; no turn is inferred from timestamps or IDs.
    // eslint-disable-next-line no-await-in-loop
    const listed = await client.call("thread/turns/list", {
      ...(cursor === null ? {} : { cursor }),
      itemsView: "notLoaded",
      limit: 1,
      sortDirection: "desc",
      threadId: recipient,
    });
    const { next, turn } = completedTurn(listed);
    if ((index === 0 && turn.id !== latestId) || seen.has(turn.id)) {
      throw new Error("native question proof head changed or turn repeated");
    }
    seen.add(turn.id);
    // eslint-disable-next-line no-await-in-loop
    const items = await itemsFor(client, pages, recipient, turn.id);
    if (items.size === 0) {
      throw new Error("native compaction predecessor is empty");
    }
    if (![...items.values()].some((item) => item.type === "contextCompaction")) {
      return turn.id;
    }
    if (items.size !== 1) {
      throw new Error("mixed native compaction turn cannot inherit question proof");
    }
    if (typeof next !== "string" || next === "" || cursors.has(next)) {
      throw new Error("native compaction predecessor unavailable");
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error("native compaction question proof bound reached");
}

async function sameCompletedHead(
  client: RpcClient,
  recipient: string,
  turnId: string,
): Promise<boolean> {
  const { turn } = completedTurn(
    await client.call("thread/turns/list", {
      itemsView: "notLoaded",
      limit: 1,
      sortDirection: "desc",
      threadId: recipient,
    }),
  );
  return turn.id === turnId;
}

async function resolvedQuestions(
  client: RpcClient,
  pages: Map<string, Map<string, NativeItem>>,
  record: DecisionRecord,
  recipient: string,
  turnId: string,
): Promise<Set<string> | string> {
  const resolved = new Set<string>();
  for (const resolution of (record.resolutions ?? []) as Resolution[]) {
    if (resolution.question_turn_id !== turnId) {
      continue;
    }
    // Each resolution reads at most two turns, in order, through the shared page cache.
    // eslint-disable-next-line no-await-in-loop
    const questionPage = await itemsFor(client, pages, recipient, resolution.question_turn_id);
    // eslint-disable-next-line no-await-in-loop
    const answerPage = await itemsFor(client, pages, recipient, resolution.answer_turn_id);
    const question = questionPage.get(resolution.question_item_id);
    const answer = answerPage.get(resolution.answer_item_id);
    if (
      question === undefined ||
      !questionItem(question) ||
      answer === undefined ||
      answer.type !== "userMessage"
    ) {
      return "recipient question resolution cannot be verified by exact native IDs";
    }
    if (resolution.question_turn_id === resolution.answer_turn_id) {
      const order = [...questionPage.keys()];
      if (order.indexOf(answer.id) <= order.indexOf(question.id)) {
        return "recipient answer item must follow its question in the same native turn";
      }
    }
    resolved.add(question.id);
  }
  return resolved;
}

interface NativeReplyBinding {
  readonly questionId: string;
  readonly titles: ReadonlyMap<number, string>;
}

/** Only the observed native UI envelope, never arbitrary prose or a substring match. */
function nativeReplyBinding(item: NativeItem): NativeReplyBinding | null {
  if (
    item.type !== "userMessage" ||
    (item.clientId !== null && !isCanonicalUuid(item.clientId)) ||
    Object.keys(item)
      .filter((key) => !ITEM_TIMESTAMPS.includes(key))
      .sort()
      .join(",") !== "clientId,content,id,type" ||
    !nativeTimestamps(item) ||
    !Array.isArray(item.content) ||
    item.content.length !== 1
  ) {
    return null;
  }
  const content: unknown = item.content[0];
  if (
    !isRecord(content) ||
    content.type !== "text" ||
    Object.keys(content).sort().join(",") !== "text,text_elements,type" ||
    !Array.isArray(content.text_elements) ||
    content.text_elements.length !== 0 ||
    typeof content.text !== "string" ||
    !content.text.startsWith(REPLY_OPEN) ||
    !content.text.endsWith(REPLY_CLOSE)
  ) {
    return null;
  }
  try {
    const raw = content.text.slice(REPLY_OPEN.length, -REPLY_CLOSE.length);
    const replies: unknown = JSON.parse(raw);
    if (!Array.isArray(replies) || replies.length === 0 || JSON.stringify(replies) !== raw) {
      return null;
    }
    let questionId: string | undefined;
    const titles = new Map<number, string>();
    for (const reply of replies as unknown[]) {
      if (
        !isRecord(reply) ||
        Object.keys(reply).sort().join(",") !== "answer,question,questionItemId" ||
        typeof reply.questionItemId !== "string" ||
        typeof reply.question !== "string" ||
        typeof reply.answer !== "string" ||
        reply.answer.trim() === ""
      ) {
        return null;
      }
      const reference: unknown = JSON.parse(reply.questionItemId);
      if (
        !Array.isArray(reference) ||
        reference.length !== 3 ||
        reference[0] !== "request_user_input_async" ||
        typeof reference[1] !== "string" ||
        reference[1] === "" ||
        (questionId !== undefined && reference[1] !== questionId) ||
        typeof reference[2] !== "number" ||
        !Number.isSafeInteger(reference[2]) ||
        reference[2] < 0 ||
        titles.has(reference[2]) ||
        JSON.stringify(reference) !== reply.questionItemId
      ) {
        return null;
      }
      questionId = reference[1];
      titles.set(reference[2], reply.question);
    }
    return questionId === undefined ? null : { questionId, titles };
  } catch {
    return null;
  }
}

function nativeQuestionReply(items: Map<string, NativeItem>, question: NativeItem): string | null {
  if (
    question.type !== "agentMessage" ||
    question.delivery !== "async" ||
    !Array.isArray(question.questions) ||
    question.questions.length === 0
  ) {
    return null;
  }
  let afterQuestion = false;
  let titles: ReadonlyMap<number, string> | undefined;
  let reply: string | null = null;
  for (const item of items.values()) {
    if (item.id === question.id) {
      afterQuestion = true;
    }
    const tagged =
      item.type === "userMessage" &&
      Array.isArray(item.content) &&
      item.content.some(
        (content: unknown) =>
          isRecord(content) &&
          typeof content.text === "string" &&
          content.text.includes("send_user_message_question_reply"),
      );
    if (!tagged) {
      continue;
    }
    const binding = nativeReplyBinding(item);
    if (binding === null) {
      return null;
    }
    if (binding.questionId === question.id) {
      if (!afterQuestion || titles !== undefined) {
        return null;
      }
      titles = binding.titles;
      reply = item.id;
    }
  }
  return titles?.size === question.questions.length &&
    question.questions.every(
      (rendered: unknown, index) =>
        isRecord(rendered) &&
        Object.keys(rendered).every((key) => key === "title" || key === "options") &&
        typeof rendered.title === "string" &&
        rendered.title !== "" &&
        rendered.title === titles?.get(index) &&
        (rendered.options == null ||
          (Array.isArray(rendered.options) &&
            rendered.options.every((option: unknown) => typeof option === "string"))),
    )
    ? reply
    : null;
}

async function ownerHead(client: RpcClient, recipient: string) {
  const read = await client.call("thread/read", { includeTurns: false, threadId: recipient });
  const thread = isRecord(read) ? read.thread : null;
  if (
    !isRecord(thread) ||
    thread.id !== recipient ||
    thread.parentThreadId != null ||
    (thread.source !== "cli" && thread.source !== "vscode") ||
    thread.canAcceptDirectInput !== true ||
    !isRecord(thread.status)
  ) {
    return null;
  }
  const { activeFlags, type } = thread.status;
  const active = type === "active";
  if (
    (type !== "idle" && !active) ||
    ((active || activeFlags !== undefined) &&
      (!Array.isArray(activeFlags) || activeFlags.length !== 0))
  ) {
    return null;
  }
  const listed = await client.call("thread/turns/list", {
    itemsView: "notLoaded",
    limit: 1,
    sortDirection: "desc",
    threadId: recipient,
  });
  const rows = isRecord(listed) && !listed.truncated && !listed.hasMore ? listed.data : null;
  const head: unknown = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  return isRecord(head) &&
    typeof head.id === "string" &&
    head.id !== "" &&
    (head.threadId === undefined || head.threadId === recipient) &&
    head.error == null &&
    head.status === (active ? "inProgress" : "completed")
    ? { active, id: head.id }
    : null;
}

/** A writer can record one exact same-turn reply while proving the current root is question-free. */
export async function proveOwnerResolution(
  client: RpcClient,
  recipient: string,
  resolution: Resolution,
): Promise<boolean> {
  if (resolution.question_turn_id !== resolution.answer_turn_id) {
    return false;
  }
  try {
    const head = await ownerHead(client, recipient);
    if (head === null) {
      return false;
    }
    const pages = new Map<string, Map<string, NativeItem>>();
    const asked = await itemsFor(client, pages, recipient, resolution.question_turn_id);
    const question = asked.get(resolution.question_item_id);
    if (
      question === undefined ||
      nativeQuestionReply(asked, question) !== resolution.answer_item_id
    ) {
      return false;
    }
    const current = await itemsFor(client, pages, recipient, head.id);
    // An active compaction cannot establish completeness. A completed one uses the wake proof.
    const compacted = [...current.values()].some((item) => item.type === "contextCompaction");
    if (compacted && head.active) {
      return false;
    }
    const currentId = compacted
      ? await precedingQuestionTurn(client, pages, recipient, head.id)
      : head.id;
    const proof = await itemsFor(client, pages, recipient, currentId);
    if (
      proof.size === 0 ||
      [...proof.values()].some(
        (item) => questionItem(item) && nativeQuestionReply(proof, item) === null,
      )
    ) {
      return false;
    }
    for (const [readTurn, snapshot] of pages) {
      // The complete native evidence must remain stable before writing.
      // eslint-disable-next-line no-await-in-loop
      const rechecked = await nativeItems(client, recipient, readTurn);
      if (!sameJson([...snapshot.values()], [...rechecked.values()])) {
        return false;
      }
    }
    return sameJson(head, await ownerHead(client, recipient));
  } catch {
    return false;
  }
}

/**
 * Exact owner-record or observed native UI envelope proof. The UI text envelope is trusted
 * within native history and the owner's clear-record boundary. The optional client UUID is
 * metadata, not origin authentication. A byte-identical manually authored native user message
 * cannot be distinguished from it.
 */
export async function nativeQuestionsClear(
  client: RpcClient,
  unblockDir: string,
  recipient: string,
  turnId: string,
  options: { readonly diagnostics?: boolean } = {},
): Promise<QuestionResult> {
  const refused = (
    category: NativeQuestionDiagnostic["category"],
    reason: string,
    classification: NativeQuestionDiagnostic["classification"] = "guarded",
    question?: NativeQuestionRef,
  ): QuestionResult =>
    refusedQuestion(
      { category, classification, ...(question === undefined ? {} : { question }) },
      reason,
      options.diagnostics === true,
    );
  try {
    const record = decisionRecord(unblockDir, recipient);
    if (record === null || record.state !== "clear") {
      return refused("decision-clearance", "recipient resolution record missing or invalid");
    }
    const pages = new Map<string, Map<string, NativeItem>>();
    const latest = await itemsFor(client, pages, recipient, turnId);
    const compacted = [...latest.values()].some((item) => item.type === "contextCompaction");
    let proofId = turnId;
    if (compacted) {
      try {
        proofId = await precedingQuestionTurn(client, pages, recipient, turnId);
      } catch {
        return refused(
          "compaction-unproven",
          "native question history incomplete or unknown",
          "unavailable",
        );
      }
    }
    const proof = await itemsFor(client, pages, recipient, proofId);
    const resolved = await resolvedQuestions(client, pages, record, recipient, proofId);
    if (typeof resolved === "string") {
      return refused("question-resolution", resolved);
    }
    let derived = false;
    for (const item of proof.values()) {
      if (
        questionItem(item) &&
        !resolved.has(item.id) &&
        nativeQuestionReply(proof, item) !== null
      ) {
        if (!derived) {
          // The first derived binding requires a completed current head on this connection.
          // eslint-disable-next-line no-await-in-loop
          const headClear = await sameCompletedHead(client, recipient, turnId);
          if (!headClear) {
            return refused(
              "binding-mismatch",
              "native answer proof requires the same completed head",
            );
          }
        }
        derived = true;
        resolved.add(item.id);
      }
    }
    for (const item of proof.values()) {
      if (questionItem(item) && !resolved.has(item.id)) {
        return refused(
          "pending-question",
          `native question pending: question_turn_id=${proofId} question_item_id=${item.id}`,
          "guarded",
          safeNativeQuestionRef({ itemId: item.id, turnId: proofId }),
        );
      }
    }
    if (derived) {
      for (const [readTurn, snapshot] of pages) {
        // Each complete turn is read again in native order before deriving admission.
        // eslint-disable-next-line no-await-in-loop
        const current = await nativeItems(client, recipient, readTurn);
        if (!sameJson([...snapshot.values()], [...current.values()])) {
          return refused("binding-mismatch", "native answer proof items changed");
        }
      }
    }
    if ((compacted || derived) && !(await sameCompletedHead(client, recipient, turnId))) {
      return refused("binding-mismatch", "native question proof head changed");
    }
    if (!clearanceUnchanged(unblockDir, recipient, record)) {
      return refused("decision-clearance", "recipient decision clearance changed");
    }
    return [true, null];
  } catch {
    return refused(
      "history-unavailable",
      "native question history incomplete or unknown",
      "unavailable",
    );
  }
}
