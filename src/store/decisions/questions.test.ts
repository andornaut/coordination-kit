import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { wakeFilePath } from "../../adapters/claude/wakeFile.ts";
import { clockAt, TEST_CONTEXT, TEST_HOST } from "../../core/testFixtures.ts";
import { Store } from "../db.ts";
import { readInbox, sendMessage } from "../messages/messages.ts";
import { wakeRecipient } from "../messages/wake.ts";
import { COORDINATOR, storeFixture, TECH } from "../testStore.ts";
import {
  answerQuestion,
  cancelQuestion,
  listDecisions,
  listHolds,
  listQuestions,
  openQuestion,
  publicText,
  questionHoldGuard,
  releaseHold,
  setHold,
} from "./questions.ts";

const TECH_ROLE = "archies-dog-walks/tech";
const TECH_ACTOR = { nativeId: TECH, role: TECH_ROLE };
const COORDINATOR_ACTOR = { nativeId: COORDINATOR, role: "game-coordinator" };

function memory(): Store {
  return Store.open(clockAt("2026-11-19T15:00:00.000Z"), ":memory:");
}

function codeOf(body: () => unknown): string | undefined {
  try {
    body();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("questions", () => {
  it("allocates role-scoped IDs per role and keeps explicit IDs", () => {
    const store = memory();
    const first = openQuestion(store, TECH_ACTOR, { title: "Pick a palette" });
    const second = openQuestion(store, TECH_ACTOR, { title: "Pick a font", work: "ag-0001" });
    const own = openQuestion(store, COORDINATOR_ACTOR, { title: "Policy wording" });
    const explicit = openQuestion(store, TECH_ACTOR, { id: "q-custom-1", title: "Explicit" });
    expect(first.question).toMatchObject({
      id: "q-archies-dog-walks-tech-1",
      role: TECH_ROLE,
      state: "pending",
    });
    expect(second.question.id).toBe("q-archies-dog-walks-tech-2");
    expect(own.question.id).toBe("q-game-coordinator-1");
    expect(explicit.question.id).toBe("q-custom-1");
    expect(openQuestion(store, TECH_ACTOR, { title: "Third" }).question.id).toBe(
      "q-archies-dog-walks-tech-3",
    );
  });

  it("treats a repeated open as a no-op and any other reuse as a conflict", () => {
    const store = memory();
    const options = [{ description: "Recommended", label: "Yes" }, { label: "No" }];
    openQuestion(store, TECH_ACTOR, { id: "q-a", options, title: "Ship it?" });
    expect(
      openQuestion(store, TECH_ACTOR, { id: "q-a", options, title: "Ship it?" }),
    ).toMatchObject({ duplicate: true, question: { options } });
    expect(codeOf(() => openQuestion(store, TECH_ACTOR, { id: "q-a", title: "Other" }))).toBe(
      "id-conflict",
    );
    expect(
      codeOf(() => openQuestion(store, COORDINATOR_ACTOR, { id: "q-a", title: "Ship it?" })),
    ).toBe("id-conflict");
  });

  it("refuses another owner's answer or cancel and leaves the question pending", () => {
    const store = memory();
    openQuestion(store, TECH_ACTOR, { id: "q-a", title: "Ship it?" });
    expect(
      codeOf(() =>
        answerQuestion(TEST_HOST, store, COORDINATOR_ACTOR, "q-a", {
          text: "Yes.",
          work: "ag-0001",
        }),
      ),
    ).toBe("not-owner");
    expect(codeOf(() => cancelQuestion(store, COORDINATOR_ACTOR, "q-a", "Not needed"))).toBe(
      "not-owner",
    );
    expect(codeOf(() => cancelQuestion(store, TECH_ACTOR, "q-missing", "Gone"))).toBe("missing");
    expect(listQuestions(store)).toMatchObject([{ id: "q-a", state: "pending" }]);
  });

  it("records numbered decisions, supersedes and duplicates, and lists them", () => {
    const store = memory();
    openQuestion(store, TECH_ACTOR, { id: "q-a", title: "First" });
    openQuestion(store, TECH_ACTOR, { id: "q-b", title: "Second", work: "ag-0001" });
    openQuestion(store, COORDINATOR_ACTOR, { id: "q-c", title: "Third" });
    const first = answerQuestion(TEST_HOST, store, TECH_ACTOR, "q-a", {
      fileNumbers: [1],
      text: "Use the warm palette.",
      work: "ag-0001",
    });
    expect(first).toMatchObject({
      decision: {
        at: "2026-11-19T15:00:00.000Z",
        by: "user",
        id: "ag-0001/D2",
        question: "q-a",
        role: TECH_ROLE,
        supersedes: null,
        text: "Use the warm palette.",
        work: "ag-0001",
      },
      duplicate: false,
      n: 2,
      question: { decision: "ag-0001/D2", state: "answered" },
    });
    expect(
      answerQuestion(TEST_HOST, store, TECH_ACTOR, "q-a", {
        text: "Use the warm palette.",
        work: "ag-0001",
      }),
    ).toMatchObject({ duplicate: true, n: 2 });
    expect(
      codeOf(() =>
        answerQuestion(TEST_HOST, store, TECH_ACTOR, "q-a", { text: "Other.", work: "ag-0001" }),
      ),
    ).toBe("already-closed");
    expect(
      codeOf(() =>
        answerQuestion(TEST_HOST, store, TECH_ACTOR, "q-b", { text: "No.", work: "ag-0002" }),
      ),
    ).toBe("work-mismatch");
    expect(
      codeOf(() =>
        answerQuestion(TEST_HOST, store, TECH_ACTOR, "q-b", {
          supersedes: "D9",
          text: "No.",
          work: "ag-0001",
        }),
      ),
    ).toBe("invalid-supersedes");
    const second = answerQuestion(TEST_HOST, store, TECH_ACTOR, "q-b", {
      supersedes: "D2",
      text: "Use the cool palette.",
      work: "ag-0001",
    });
    expect(second.decision).toMatchObject({ id: "ag-0001/D3", supersedes: "ag-0001/D2" });
    answerQuestion(TEST_HOST, store, COORDINATOR_ACTOR, "q-c", {
      by: "game-coordinator",
      text: "Keep.",
      work: "gc-0001",
    });
    expect(listDecisions(store).map((row) => row.id)).toEqual([
      "ag-0001/D2",
      "ag-0001/D3",
      "gc-0001/D1",
    ]);
    expect(listDecisions(store, { work: "ag-0001" })).toHaveLength(2);
    expect(listDecisions(store, { role: "game-coordinator" })).toMatchObject([
      { by: "game-coordinator", id: "gc-0001/D1" },
    ]);
    expect(listQuestions(store, { states: ["answered"] })).toHaveLength(3);
  });

  it("keeps decision text public", () => {
    expect(publicText(TEST_HOST, "Use the warm palette.")).toBe("Use the warm palette.");
    expect(publicText("other-host", `Built on ${TEST_HOST}.`)).toBe(`Built on ${TEST_HOST}.`);
    for (const text of [
      `Built on ${TEST_HOST.toUpperCase()}.`,
      "See /home/someone/notes",
      "Session 00000000-0000-4000-8000-000000000001",
      "two\nlines",
    ]) {
      expect(codeOf(() => publicText(TEST_HOST, text))).toMatch(/^(text-not-public|invalid-text)$/);
    }
  });

  it("cancels once and refuses a cancel after an answer", () => {
    const store = memory();
    openQuestion(store, TECH_ACTOR, { id: "q-a", title: "First" });
    expect(cancelQuestion(store, TECH_ACTOR, "q-a", "Superseded by the plan")).toMatchObject({
      duplicate: false,
      question: { reason: "Superseded by the plan", state: "cancelled" },
    });
    expect(cancelQuestion(store, TECH_ACTOR, "q-a", "Superseded by the plan").duplicate).toBe(true);
    expect(
      codeOf(() =>
        answerQuestion(TEST_HOST, store, TECH_ACTOR, "q-a", { text: "Yes.", work: "ag-0001" }),
      ),
    ).toBe("already-closed");
  });
});

describe("holds", () => {
  it("sets holds owned by the caller and lets only the owner release them", () => {
    const store = memory();
    expect(
      setHold(store, TECH_ACTOR, { id: "h-1", reason: "Waiting on art", scope: "work:ag-0001" }),
    ).toMatchObject({ duplicate: false, hold: { role: TECH_ROLE, state: "active" } });
    setHold(store, TECH_ACTOR, { id: "h-2", reason: "Paused", scope: "role" });
    setHold(store, COORDINATOR_ACTOR, {
      id: "h-3",
      reason: "Cutover",
      scope: "game:archies-dog-walks",
    });
    expect(
      setHold(store, TECH_ACTOR, { id: "h-1", reason: "Waiting on art", scope: "work:ag-0001" })
        .duplicate,
    ).toBe(true);
    expect(
      codeOf(() => setHold(store, TECH_ACTOR, { id: "h-4", reason: "x", scope: "team" })),
    ).toBe("invalid-scope");
    expect(codeOf(() => releaseHold(store, COORDINATOR_ACTOR, "h-1"))).toBe("not-owner");
    expect(releaseHold(store, TECH_ACTOR, "h-1")).toMatchObject({
      duplicate: false,
      hold: { state: "released" },
    });
    expect(releaseHold(store, TECH_ACTOR, "h-1").duplicate).toBe(true);
    expect(
      codeOf(() =>
        setHold(store, TECH_ACTOR, { id: "h-1", reason: "Waiting on art", scope: "work:ag-0001" }),
      ),
    ).toBe("id-conflict");
    expect(listHolds(store, { states: ["active"] }).map((hold) => hold.id)).toEqual(["h-2", "h-3"]);
    expect(listHolds(store, { role: TECH_ROLE }).map((hold) => hold.id)).toEqual(["h-1", "h-2"]);
  });
});

describe("imported holds", () => {
  it("projects hold.imported with its recorded owner and never releases it by import", () => {
    const store = memory();
    const imported = (id: string, owner: string | null, state: string | null) =>
      store.append({
        actor: COORDINATOR_ACTOR,
        key: `hold.imported:approval-ledger:${id}`,
        kind: "hold.imported",
        payload: {
          entries: ["entry-1"],
          id: `approval-ledger:${id}`,
          owner,
          reason: "Imported hold",
          source: "approval-ledger",
          state,
          work: [{ id: "ag-0001", repository: "archies-dog-walks" }],
        },
      });
    imported("open", TECH_ROLE, "preserved");
    imported("orphan", null, null);
    imported("closed", TECH_ROLE, "released");
    imported("open", "game-coordinator", "released");
    expect(listHolds(store)).toEqual([
      expect.objectContaining({
        id: "approval-ledger:open",
        role: TECH_ROLE,
        scope: "work:archies-dog-walks:ag-0001",
        source: "approval-ledger",
        state: "active",
      }),
      expect.objectContaining({ id: "approval-ledger:orphan", role: null, state: "active" }),
      expect.objectContaining({
        id: "approval-ledger:closed",
        releasedAt: null,
        state: "released",
      }),
    ]);
    expect(codeOf(() => releaseHold(store, COORDINATOR_ACTOR, "approval-ledger:open"))).toBe(
      "not-owner",
    );
    expect(releaseHold(store, TECH_ACTOR, "approval-ledger:open").hold.state).toBe("released");
    store.rebuild();
    expect(listHolds(store, { states: ["active"] }).map((hold) => hold.id)).toEqual([
      "approval-ledger:orphan",
    ]);
  });
});

describe("wake guard", () => {
  it("withholds wakes while a question is pending or a role hold is active, then wakes", async () => {
    const { layout } = storeFixture();
    const store = Store.forLayout(TEST_CONTEXT, layout);
    let n = 0;
    const send = async () => {
      n++;
      sendMessage(store, COORDINATOR_ACTOR, {
        body: "Body.",
        id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
        intent: "queue",
        to: TECH_ROLE,
      });
      return wakeRecipient({ env: {}, layout, store }, TECH_ROLE);
    };
    openQuestion(store, TECH_ACTOR, { id: "q-a", title: "Ship it?" });
    expect(questionHoldGuard(store, TECH_ROLE)).toEqual({
      blocker: { id: "q-a", kind: "question", owner: TECH_ROLE },
      reason: "recipient-question-pending",
      status: "blocked",
    });
    expect(await send()).toMatchObject({ reason: "recipient-question-pending", status: "guarded" });
    expect(existsSync(wakeFilePath(layout, TECH_ROLE))).toBe(false);
    cancelQuestion(store, TECH_ACTOR, "q-a", "Answered in the plan");
    setHold(store, TECH_ACTOR, { id: "h-work", reason: "Scoped", scope: "work:ag-0001" });
    setHold(store, TECH_ACTOR, { id: "h-role", reason: "Paused", scope: "role" });
    expect(await send()).toMatchObject({ reason: "recipient-hold-active", status: "guarded" });
    releaseHold(store, TECH_ACTOR, "h-role");
    expect(questionHoldGuard(store, TECH_ROLE)).toEqual({ status: "clear" });
    expect(await send()).toMatchObject({ status: "accepted" });
    expect(existsSync(wakeFilePath(layout, TECH_ROLE))).toBe(true);
    expect(readInbox(store, TECH_ACTOR).delivered).toBe(3);
    const outcomes = [...store.index.rows("wakes")]
      .sort((a, b) => Number(a.seq) - Number(b.seq))
      .map(({ detail, outcome }) => ({ detail, outcome }));
    expect(outcomes).toEqual([
      { detail: "recipient-question-pending", outcome: "guarded" },
      { detail: "recipient-hold-active", outcome: "guarded" },
      { detail: null, outcome: "accepted" },
    ]);
    store.close();
  });

  it("rebuilds the question, hold and decision tables from the events", () => {
    const store = memory();
    openQuestion(store, TECH_ACTOR, { id: "q-a", title: "First" });
    answerQuestion(TEST_HOST, store, TECH_ACTOR, "q-a", { text: "Yes.", work: "ag-0001" });
    setHold(store, TECH_ACTOR, { id: "h-1", reason: "Paused", scope: "role" });
    const before = [listQuestions(store), listDecisions(store), listHolds(store)];
    store.rebuild();
    expect([listQuestions(store), listDecisions(store), listHolds(store)]).toEqual(before);
  });
});
