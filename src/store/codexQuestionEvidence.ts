import { performance } from "node:perf_hooks";

import { collectQuestionState } from "../adapters/codex/collectors/questionState.ts";
import { connectControl } from "../adapters/codex/rpc.ts";
import { decisionDirectory, decisionRecord } from "../adapters/shared/decisions.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import type { Layout } from "../layout.ts";
import type { NativeQuestionIdentity, NativeQuestionProof } from "./codexQuestions.ts";
import type { QuestionView } from "./questions.ts";

interface EvidenceContext {
  readonly env: NodeJS.ProcessEnv;
  readonly layout: Layout;
}

type Observation = Exclude<NativeQuestionProof, { readonly status: "unknown" }>;
export type QuestionEvidence = (
  question: QuestionView,
  native: NativeQuestionIdentity,
) => Promise<NativeQuestionProof>;

const unavailable = (reason: string): NativeQuestionProof => ({ reason, status: "unknown" });

/** Rendered identity and reply proof are distinct from exact live form visibility. */
export function nativeQuestionObservation(
  question: QuestionView,
  native: NativeQuestionIdentity,
  history: unknown,
): NativeQuestionProof {
  const thread = question.codex?.thread;
  if (thread === undefined || !isRecord(history) || !Array.isArray(history.questions)) {
    return unavailable("native-history-unavailable");
  }
  const rendered = (history.questions as unknown[])
    .filter(isRecord)
    .filter(
      (row) =>
        row.kind === "rendered_prompt" &&
        row.turn_id === native.turn &&
        row.item_id === native.item,
    );
  const matches = rendered.filter((row) => row.question_index === native.index);
  const row = matches.length === 1 ? matches[0]! : null;
  const options = question.options?.map(({ label }) => label) ?? null;
  if (
    row === null ||
    row.title !== question.title ||
    JSON.stringify(row.options) !== JSON.stringify(options)
  ) {
    return unavailable("native-question-identity-unavailable");
  }
  const observed = { native, thread };
  if (row.state === "pending" && row.proof_complete === true) {
    return { ...observed, status: "pending" };
  }
  if (history.complete !== true) {
    return unavailable("native-history-incomplete");
  }
  // Resolution markers in the existing adapter identify a whole item. An item with more
  // than one question does not prove which question a later user message answered.
  if (
    row.state === "answered" &&
    rendered.length === 1 &&
    Array.isArray(row.proof_refs) &&
    row.proof_refs.length === 1
  ) {
    const proof = row.proof_refs[0] as unknown;
    if (
      isRecord(proof) &&
      proof.recipient === thread &&
      proof.question_turn_id === native.turn &&
      proof.question_item_id === native.item &&
      typeof proof.answer_turn_id === "string" &&
      typeof proof.answer_item_id === "string"
    ) {
      return {
        ...observed,
        reply: { item: proof.answer_item_id, turn: proof.answer_turn_id },
        status: "answered",
      };
    }
  }
  return { ...observed, status: "observed" } satisfies Observation;
}

/** Use the bounded read-only collector. No available method proves cancellation or reopens a form. */
export async function readCodexQuestionEvidence(
  context: EvidenceContext,
  question: QuestionView,
  native: NativeQuestionIdentity,
): Promise<NativeQuestionProof> {
  const thread = question.codex?.thread;
  if (thread === undefined) {
    return unavailable("native-question-unlinked");
  }
  let socket: string;
  try {
    socket = resolveCodexControlSocket({ env: context.env }).path;
  } catch {
    return unavailable("native-endpoint-unavailable");
  }
  const directory = decisionDirectory(context.layout, question.role);
  const record = directory === null ? null : decisionRecord(directory, thread);
  try {
    const client = await connectControl(performance.now() + 4000, socket);
    try {
      const result = await collectQuestionState(client, { [thread]: record }, [thread], 3, {
        maxCalls: 12,
      });
      return nativeQuestionObservation(question, native, result[thread]);
    } finally {
      client.close();
    }
  } catch {
    return unavailable("native-history-unavailable");
  }
}
