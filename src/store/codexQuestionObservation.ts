// What a bounded native question history proves about one linked Codex question: pending, answered
// with an exact reply, observed, or unknown with a reason. Pure; the evidence reader supplies the
// history.
import { isRecord } from "../core/pyjson.ts";
import type { NativeQuestionProof } from "./codexQuestions.ts";
import type { QuestionView } from "./questions.ts";
import type { NativeQuestionIdentity } from "./types.ts";

type Observation = Exclude<NativeQuestionProof, { readonly status: "unknown" }>;

/** Proof that the native state is unknown, with the reason. */
export const unknownProof = (reason: string): NativeQuestionProof => ({
  reason,
  status: "unknown",
});

/** Rendered identity and reply proof are distinct from exact live form visibility. */
export function nativeQuestionObservation(
  question: QuestionView,
  native: NativeQuestionIdentity,
  history: unknown,
): NativeQuestionProof {
  const thread = question.codex?.thread;
  if (thread === undefined || !isRecord(history) || !Array.isArray(history.questions)) {
    return unknownProof("native-history-unavailable");
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
    return unknownProof("native-question-identity-unavailable");
  }
  const observed = { native, thread };
  if (row.state === "pending" && row.proof_complete === true) {
    return { ...observed, status: "pending" };
  }
  if (history.complete !== true) {
    return unknownProof("native-history-incomplete");
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
