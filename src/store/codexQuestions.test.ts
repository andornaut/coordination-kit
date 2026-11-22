import { describe, expect, it } from "vitest";

import { nativeQuestionObservation } from "./codexQuestionEvidence.ts";
import { dependentQuestions, type NativeQuestionProof } from "./codexQuestions.ts";
import { Store } from "./db.ts";
import {
  cancelQuestion,
  linkNativeQuestion,
  listQuestions,
  openQuestion,
  reaskNativeQuestion,
  recordQuestionAnswer,
} from "./questions.ts";
import { ART, COORDINATOR, GAME, TECH } from "./testStore.ts";

const actor = { nativeId: ART, role: `${GAME}/art` };
const native = { index: 0, item: "question-item", turn: "question-turn" };
const next = { index: 0, item: "next-item", turn: "next-turn" };
const ref = { id: "ag-0001", repository: GAME };
const unknown = { reason: "exact-native-state-unavailable", status: "unknown" } as const;
const answer = { text: "Warm.", work: ref.id };
const wording = "Pick a palette.\nWhich do you prefer?";
const options = [{ description: "High saturation", label: "Warm" }, { label: "Cool" }];

function fixture() {
  const store = Store.open(":memory:");
  const opened = openQuestion(store, actor, {
    codex: { dependsOn: [ref], thread: ART },
    id: "q-palette",
    options,
    title: wording,
    work: ref.id,
  });
  return { question: opened.question, store };
}

const observation = (
  status: "observed" | "closed-without-answer" | "cancelled",
  identity = native,
): NativeQuestionProof => ({ native: identity, status, thread: ART });

describe("Codex question lifecycle", () => {
  it("preserves the exact question, options and dependencies through replay", () => {
    const { question, store } = fixture();
    expect(question).toMatchObject({
      codex: { attempt: 1, dependsOn: [ref], native: null, thread: ART },
      options,
      state: "pending",
      title: wording,
    });
    expect(dependentQuestions(store, ref)).toEqual(["q-palette"]);
    expect(dependentQuestions(store, { ...ref, repository: "other" })).toEqual([]);
    expect(() =>
      linkNativeQuestion(
        store,
        { nativeId: TECH, role: actor.role },
        question.id,
        native,
        observation("observed"),
      ),
    ).toThrow("question-thread-mismatch");
    expect(() =>
      linkNativeQuestion(
        store,
        { nativeId: COORDINATOR, role: "game-coordinator" },
        question.id,
        native,
        observation("observed"),
      ),
    ).toThrow("not-owner");
    expect(() => linkNativeQuestion(store, actor, question.id, native, unknown)).toThrow(
      "native-question-unverified",
    );
    expect(
      linkNativeQuestion(store, actor, question.id, native, observation("observed")).question,
    ).toMatchObject({ codex: { native, thread: ART } });
    expect(
      linkNativeQuestion(store, actor, question.id, native, observation("observed")).duplicate,
    ).toBe(true);
    const before = listQuestions(store);
    store.rebuild();
    expect(listQuestions(store)).toEqual(before);
    store.close();
  });

  it("keeps ambiguous and resolution-only prompts open until exact reply evidence", () => {
    const { question, store } = fixture();
    linkNativeQuestion(store, actor, question.id, native, observation("observed"));
    expect(() => recordQuestionAnswer(store, actor, question.id, answer)).toThrow(
      "native-question-unverified",
    );
    expect(() => reaskNativeQuestion(store, actor, question.id, unknown)).toThrow(
      "native-question-unverified",
    );
    expect(() =>
      cancelQuestion(store, actor, question.id, "Cancelled", observation("observed")),
    ).toThrow("native-question-proof-mismatch");
    const proof = {
      native,
      reply: { item: "user-reply", turn: "reply-turn" },
      status: "answered",
      thread: ART,
    } as const;
    expect(() =>
      recordQuestionAnswer(store, actor, question.id, answer, { ...proof, native: next }),
    ).toThrow("native-question-proof-mismatch");
    expect(dependentQuestions(store, ref)).toEqual(["q-palette"]);
    expect(recordQuestionAnswer(store, actor, question.id, answer, proof).question).toMatchObject({
      codex: { native, resolution: { outcome: "answered", reply: proof.reply } },
      state: "answered",
    });
    expect(dependentQuestions(store, ref)).toEqual([]);
    store.close();
  });

  it("reuses the durable ID only after exact closure without an answer", () => {
    const { question, store } = fixture();
    linkNativeQuestion(store, actor, question.id, native, observation("observed"));
    const closed = observation("closed-without-answer");
    expect(reaskNativeQuestion(store, actor, question.id, closed)).toMatchObject({
      question: {
        codex: { attempt: 2, native: null },
        id: question.id,
        state: "pending",
        title: wording,
      },
    });
    expect(reaskNativeQuestion(store, actor, question.id, closed).duplicate).toBe(true);
    expect(() =>
      linkNativeQuestion(store, actor, question.id, native, observation("observed")),
    ).toThrow("native-question-id-conflict");
    linkNativeQuestion(store, actor, question.id, next, observation("observed", next));
    expect(() =>
      recordQuestionAnswer(store, actor, question.id, answer, {
        native,
        reply: { item: "reply", turn: "later" },
        status: "answered",
        thread: ART,
      }),
    ).toThrow("native-question-proof-mismatch");
    expect(dependentQuestions(store, ref)).toEqual(["q-palette"]);
    expect(
      cancelQuestion(store, actor, question.id, "User cancelled.", observation("cancelled", next))
        .question,
    ).toMatchObject({
      codex: { attempt: 2, resolution: { outcome: "cancelled", reply: null } },
      state: "cancelled",
    });
    expect(dependentQuestions(store, ref)).toEqual([]);
    store.close();
  });

  it("records a direct explicit live owner answer when native references were absent", () => {
    const { question, store } = fixture();
    expect(recordQuestionAnswer(store, actor, question.id, answer).question).toMatchObject({
      codex: { native: null, resolution: null },
      state: "answered",
    });
    store.close();
  });

  it("distinguishes complete rendered reply evidence from incomplete and ambiguous history", () => {
    const { question, store } = fixture();
    const row = {
      item_id: native.item,
      kind: "rendered_prompt",
      options: ["Warm", "Cool"],
      proof_refs: [
        {
          answer_item_id: "reply",
          answer_turn_id: "later",
          question_item_id: native.item,
          question_turn_id: native.turn,
          recipient: ART,
        },
      ],
      question_index: native.index,
      state: "answered",
      title: wording,
      turn_id: native.turn,
    };
    const read = (questions: unknown[], complete = true) =>
      nativeQuestionObservation(question, native, { complete, questions });
    expect(read([row])).toMatchObject({
      native,
      reply: { item: "reply", turn: "later" },
      status: "answered",
      thread: ART,
    });
    expect(read([row], false)).toMatchObject({ status: "unknown" });
    expect(read([{ ...row, kind: "question_tool" }])).toMatchObject({ status: "unknown" });
    expect(read([{ ...row, state: "cancelled" }])).toMatchObject({ status: "observed" });
    expect(read([{ ...row, proof_refs: [] }])).toMatchObject({ status: "observed" });
    expect(read([row, { ...row, question_index: 1 }])).toMatchObject({ status: "observed" });
    expect(read([{ ...row, options: ["Cool", "Warm"] }])).toMatchObject({ status: "unknown" });
    expect(read([{ ...row, proof_complete: true, state: "pending" }])).toMatchObject({
      status: "pending",
    });
    store.close();
  });
});
