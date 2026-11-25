import { describe, expect, it } from "vitest";

import { TEST_CLOCK, TEST_HOST } from "../core/testFixtures.ts";
import { nativeQuestionObservation } from "./codexQuestionObservation.ts";
import { dependentQuestions } from "./codexQuestions.ts";
import { MEMORY, Store } from "./db.ts";
import type { FileProjection } from "./fileProjection.ts";
import { fileRecords } from "./files/records.ts";
import {
  cancelQuestion,
  closeLegacyQuestion,
  listQuestions,
  openQuestion,
  recordQuestionAnswer,
} from "./questions.ts";
import { ART, COORDINATOR, GAME } from "./testStore.ts";
import type { NativeQuestionIdentity } from "./types.ts";

const actor = { nativeId: ART, role: `${GAME}/art` };
const native = { index: 0, item: "question-item", turn: "question-turn" };
const next = { index: 0, item: "next-item", turn: "next-turn" };
const ref = { id: "ag-0001", repository: GAME };
const answer = { text: "Warm.", work: ref.id };
const wording = "Pick a palette.\nWhich do you prefer?";
const options = [{ description: "High saturation", label: "Warm" }, { label: "Cool" }];

function fixture() {
  const store = Store.open(TEST_CLOCK, ":memory:");
  const opened = openQuestion(store, actor, {
    codex: { dependsOn: [ref], thread: ART },
    id: "q-palette",
    options,
    title: wording,
    work: ref.id,
  });
  return { question: opened.question, store };
}

const ROTATED = "00000000-0000-4000-8000-0000000000f1";

/** Append a `question.native-linked` event in its stored shape; no command writes one. */
function legacyLink(store: Store, id: string, identity: NativeQuestionIdentity, attempt = 1) {
  store.append({
    actor,
    key: `question.native-linked:${id}:${attempt}`,
    kind: "question.native-linked",
    payload: { id, native: { ...identity }, thread: ART },
  });
}

/** Append a `question.native-reasked` event in its stored shape; no command writes one. */
function legacyReask(store: Store, id: string, identity: NativeQuestionIdentity, attempt = 1) {
  store.append({
    actor,
    key: `question.native-reasked:${id}:${attempt}`,
    kind: "question.native-reasked",
    payload: { id, native: { ...identity }, thread: ART },
  });
}

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
      legacyLink(store, "q-palette", native);
      legacyLink(store, "q-other", next);
    }
    const stranger = { nativeId: COORDINATOR, role: "game-coordinator" };
    expect(() => recordQuestionAnswer(TEST_HOST, store, stranger, "q-palette", answer)).toThrow(
      "not-owner",
    );
    expect(() => cancelQuestion(store, stranger, "q-other", "Not needed.")).toThrow("not-owner");
    expect(
      recordQuestionAnswer(TEST_HOST, store, owner, "q-palette", answer).question,
    ).toMatchObject({
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

  it("rebuilds native link and reask events from a store and a file journal", () => {
    const { question, store } = fixture();
    legacyLink(store, question.id, native);
    legacyReask(store, question.id, native);
    legacyLink(store, question.id, next, 2);
    const expected = { codex: { attempt: 2, native: next, thread: ART }, state: "pending" };
    expect(listQuestions(store)).toMatchObject([expected]);
    const before = listQuestions(store);
    store.rebuild();
    expect(listQuestions(store)).toEqual(before);

    const events = store.events();
    expect(events.map(({ kind }) => kind)).toEqual([
      "question.opened",
      "question.native-linked",
      "question.native-reasked",
      "question.native-linked",
    ]);
    const read = (after = 0) => events.filter(({ seq }) => seq > after);
    const journal: FileProjection = {
      journal: { events: read, withWriter: (body) => body({ commit: () => {}, events: read }) },
      records: () => [],
    };
    const replayed = Store.openFileProjection(TEST_CLOCK, MEMORY, journal);
    expect(listQuestions(replayed)).toEqual(before);
    expect(replayed.verify()).toEqual(store.verify());
    replayed.close();

    const records = fileRecords(events, { registeredRoles: new Set([actor.role]) });
    const owner = `roles/${encodeURIComponent(actor.role)}`;
    expect(records.map(({ path }) => path)).toEqual(
      [1, 2, 3, 4].map((seq) => `${owner}/questions/q-palette/${seq}.json`),
    );
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
