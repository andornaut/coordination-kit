// Review collectors share one connection, with reserved worker capacity inside the overall
// call and time limits.
import { performance } from "node:perf_hooks";

import type { Clock } from "../../core/clock.ts";
import { isRecord, unicodeDumps } from "../../core/pyjson.ts";
import type { Collected, CollectRequest } from "../types.ts";
import { workerHealth } from "./collectors/childHealth.ts";
import { collectQuestionState } from "./collectors/questionState.ts";
import { NativeTimeout, type RpcClient } from "./rpc.ts";

type Json = Record<string, unknown>;

const MAX_COLLECTION_CALLS = 256;
const CONNECTION_RESERVE_MS = 5000;
const WORKER_RESERVE_MS = 8000;
const WORKER_RESERVE_CALLS = 96;
const QUESTION_BOUND = 32768;

/** The bounded RPC client for one collection phase. */
class BudgetClient implements RpcClient {
  private readonly client: RpcClient;
  readonly maxCalls: number;
  /** Read by collectors that stop early. */
  readonly deadline: number;
  callsUsed = 0;
  reasonCode: string | null = null;

  constructor(client: RpcClient, deadline: number, maxCalls: number) {
    this.client = client;
    this.deadline = deadline;
    this.maxCalls = maxCalls;
  }

  async call(method: string, params: unknown, deadline = this.deadline): Promise<unknown> {
    if (performance.now() >= this.deadline) {
      this.reasonCode = "collection_deadline_exhausted";
    }
    if (this.callsUsed >= this.maxCalls) {
      this.reasonCode = "collection_call_budget_exhausted";
    }
    if (this.reasonCode !== null) {
      throw new NativeTimeout("collection phase budget");
    }
    this.callsUsed += 1;
    try {
      return await this.client.call(method, params, Math.min(deadline, this.deadline));
    } catch (error) {
      if (error instanceof NativeTimeout && deadline >= this.deadline) {
        this.reasonCode = "collection_timeout";
      }
      throw error;
    }
  }

  close(): void {
    // The underlying connection belongs to the caller.
  }
}

function questionUnavailable(code: string): Json {
  return {
    cancelled_status: "unavailable",
    complete: false,
    diagnostics: [code],
    pending_status: "unavailable",
    questions: [],
    status: "unavailable",
    ui_visibility: "unknown",
  };
}

const COLLECTED: ReadonlySet<unknown> = new Set(["complete", "partial", "unavailable"]);
const QUESTION_FIELDS = ["turn_id", "item_id", "question_index", "kind", "title", "options"];

/** Keep exact snapshot choices; a question too large for a reminder is marked unknown. */
function boundQuestions(owner: string, value: Json): void {
  for (const question of value.questions as unknown[]) {
    if (!isRecord(question)) {
      continue;
    }
    // Key order: owner, level, then the fields.
    const content = Object.fromEntries([
      ["owner", owner],
      ["level", "escalation"],
      ...QUESTION_FIELDS.map((key) => [key, question[key] ?? null]),
    ]) as Json;
    if (Buffer.byteLength(unicodeDumps(content), "utf8") > QUESTION_BOUND) {
      question.state = "unknown";
      value.status = "partial";
      value.complete = false;
      const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : [];
      diagnostics.push("question_text_exceeds_reminder_bounds");
      value.diagnostics = diagnostics;
    }
  }
}

async function questionState(
  clock: Clock,
  client: RpcClient,
  decisions: CollectRequest["decisionRecords"],
  recipients: readonly string[],
): Promise<Json> {
  let collected: Json;
  try {
    collected = await collectQuestionState(clock, client, decisions, recipients);
  } catch (error) {
    const code =
      error instanceof NativeTimeout
        ? "question_collection_budget_exhausted"
        : "question_collector_unavailable";
    collected = Object.fromEntries(
      recipients.map((recipient) => [recipient, questionUnavailable(code)]),
    );
  }
  const result: Json = {};
  for (const recipient of recipients) {
    const value = collected[recipient];
    const valid = isRecord(value) && COLLECTED.has(value.status) && Array.isArray(value.questions);
    const chosen = valid ? value : questionUnavailable("question_collector_unavailable");
    boundQuestions(recipient, chosen);
    result[recipient] = chosen;
  }
  return result;
}

/** Collect every snapshot capability over `client`, whose own deadline is `deadline`. */
export async function collectAll(
  clock: Clock,
  client: RpcClient,
  deadline: number,
  request: CollectRequest,
): Promise<Collected> {
  const recipients = [...new Set(request.recipients)];
  const collectionDeadline = deadline - CONNECTION_RESERVE_MS;
  const hasParents = request.parents.length > 0;
  const questionsBudget = new BudgetClient(
    client,
    collectionDeadline - (hasParents ? WORKER_RESERVE_MS : 0),
    MAX_COLLECTION_CALLS - (hasParents ? WORKER_RESERVE_CALLS : 0),
  );
  const questions = await questionState(
    clock,
    questionsBudget,
    request.decisionRecords,
    recipients,
  );
  const workerBudget = new BudgetClient(
    client,
    collectionDeadline,
    MAX_COLLECTION_CALLS - questionsBudget.callsUsed,
  );
  const workers = hasParents ? await workerHealth(clock, workerBudget, request.parents) : {};
  return {
    collection_budget: {
      calls_used: questionsBudget.callsUsed + workerBudget.callsUsed,
      max_calls: MAX_COLLECTION_CALLS,
      reason_code: questionsBudget.reasonCode ?? workerBudget.reasonCode,
    },
    history: {},
    question_state: questions,
    worker_health: workers,
  };
}

/** Every collector unavailable with one reason code, for a missing socket or connection. */
export function unavailableCollected(reasonCode: string, request: CollectRequest): Collected {
  const unavailable = { reason_code: reasonCode, status: "unavailable" };
  return {
    collection_budget: { calls_used: 0, max_calls: MAX_COLLECTION_CALLS, reason_code: reasonCode },
    history: Object.fromEntries(request.recipients.map((id) => [id, { ...unavailable }])),
    question_state: Object.fromEntries(
      request.recipients.map((id) => [id, questionUnavailable(reasonCode)]),
    ),
    worker_health: Object.fromEntries(request.parents.map((id) => [id, { ...unavailable }])),
  };
}
