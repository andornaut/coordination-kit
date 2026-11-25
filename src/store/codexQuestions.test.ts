import { describe, expect, it } from "vitest";

import { nativeQuestionObservation } from "./codexQuestionEvidence.ts";
import { dependentQuestions, type NativeQuestionProof } from "./codexQuestions.ts";
import { Store } from "./db.ts";
import {
  cancelQuestion,
  closeLegacyQuestion,
  linkNativeQuestion,
  listQuestions,
  openQuestion,
  reaskNativeQuestion,
  recordQuestionAnswer,
} from "./questions.ts";
import { ART, COORDINATOR, GAME } from "./testStore.ts";

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

const ROTATED = "00000000-0000-4000-8000-0000000000f1";

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
        { nativeId: COORDINATOR, role: "game-coordinator" },
        question.id,
        native,
        observation("observed"),
      ),
    ).toThrow("not-owner");
    expect(() => linkNativeQuestion(store, actor, question.id, native, unknown)).toThrow(
      "native-question-unverified",
    );
    // A rotated binding of the same role attaches evidence about the original thread.
    expect(
      linkNativeQuestion(
        store,
        { nativeId: ROTATED, role: actor.role },
        question.id,
        native,
        observation("observed"),
      ).question,
    ).toMatchObject({ codex: { native, thread: ART } });
    expect(
      linkNativeQuestion(store, actor, question.id, native, observation("observed")).duplicate,
    ).toBe(true);
    const before = listQuestions(store);
    store.rebuild();
    expect(listQuestions(store)).toEqual(before);
    store.close();
  });

  it.each([
    { binding: ART, linked: false, name: "the opening thread, unlinked" },
    { binding: ART, linked: true, name: "the opening thread, linked" },
    { binding: ROTATED, linked: false, name: "a rotated binding, unlinked" },
    { binding: ROTATED, linked: true, name: "a rotated binding, linked" },
  ])("answers and cancels by role from $name without native proof", ({ binding, linked }) => {
    const owner = { nativeId: binding, role: actor.role };
    const { store } = fixture();
    openQuestion(store, actor, {
      codex: { dependsOn: [], thread: ART },
      id: "q-other",
      title: "Other?",
    });
    if (linked) {
      linkNativeQuestion(store, actor, "q-palette", native, observation("observed"));
      linkNativeQuestion(store, actor, "q-other", next, observation("observed", next));
    }
    const stranger = { nativeId: COORDINATOR, role: "game-coordinator" };
    expect(() => recordQuestionAnswer(store, stranger, "q-palette", answer)).toThrow("not-owner");
    expect(() => cancelQuestion(store, stranger, "q-other", "Not needed.")).toThrow("not-owner");
    expect(recordQuestionAnswer(store, owner, "q-palette", answer).question).toMatchObject({
      codex: { resolution: null },
      state: "answered",
    });
    expect(dependentQuestions(store, ref)).toEqual([]);
    expect(cancelQuestion(store, owner, "q-other", "Not needed.").question).toMatchObject({
      reason: "Not needed.",
      state: "cancelled",
    });
    store.close();
  });

  it("reuses the durable ID only after exact closure without an answer", () => {
    const { question, store } = fixture();
    linkNativeQuestion(store, actor, question.id, native, observation("observed"));
    expect(() => reaskNativeQuestion(store, actor, question.id, unknown)).toThrow(
      "native-question-unverified",
    );
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
    expect(dependentQuestions(store, ref)).toEqual(["q-palette"]);
    store.close();
  });

  it("closes a pending Codex-period question once with the owner's approval reference", () => {
    const { store } = fixture();
    openQuestion(store, actor, { harness: "claude", id: "q-claude", title: "Claude?" });
    openQuestion(store, actor, {
      codex: { dependsOn: [ref], thread: ART },
      harness: "claude",
      id: "q-claude-depends",
      title: "Claude with dependencies?",
    });
    const rotated = { nativeId: ROTATED, role: actor.role };
    const close = (id: string, who = rotated, approval = "user-2026-11-25") =>
      closeLegacyQuestion(store, who, { approval, id, reason: "Closed after the move." });
    for (const [id, who, approval, code] of [
      ["q-palette", { nativeId: COORDINATOR, role: "game-coordinator" }, "r", "not-owner"],
      ["q-palette", rotated, " ", "invalid-approval"],
      ["q-claude", rotated, "r", "legacy-question-required"],
      ["q-claude-depends", rotated, "r", "legacy-question-required"],
    ] as const) {
      expect(() => close(id, who, approval)).toThrow(code);
    }
    expect(close("q-palette")).toMatchObject({
      approval: "user-2026-11-25",
      duplicate: false,
      question: { reason: "Closed after the move.", state: "cancelled" },
    });
    expect(close("q-palette").duplicate).toBe(true);
    expect(() => close("q-palette", rotated, "other")).toThrow("already-closed");
    expect(store.eventByKey("question.cancelled:q-palette")?.payload).toEqual({
      approval: "user-2026-11-25",
      id: "q-palette",
      reason: "Closed after the move.",
    });
    expect(dependentQuestions(store, ref)).toEqual(["q-claude-depends"]);
    const before = listQuestions(store);
    store.rebuild();
    expect(listQuestions(store)).toEqual(before);
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
