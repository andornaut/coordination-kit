import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { decisionDirectory } from "../adapters/shared/decisions.ts";
import { gameLayout, type Layout } from "../layout.ts";
import { ART, GAME, storeFixture } from "../store/testStore.ts";
import { writeFixtureJson } from "../testFixtures.ts";
import { type NativeCollect, surveyNative } from "./storeNative.ts";

const CHIBI = "chibis-way-home";
const CHIBI_ART = "00000000-0000-4000-8000-000000000001";
const SHARED = "00000000-0000-4000-8000-000000000002";
const CHILD = "00000000-0000-4000-8000-000000000003";
const TURN = "00000000-0000-4000-8000-000000000004";
const HEALTHY_CHILD = "00000000-0000-4000-8000-000000000005";
const UNREADABLE_CHILD = "00000000-0000-4000-8000-000000000006";

function marker(layout: Layout, game: string, recipient: string, state: "clear" | "pending"): void {
  const directory = join(gameLayout(layout, game).busDir, "unblock", "decisions");
  mkdirSync(directory, { recursive: true });
  writeFixtureJson(join(directory, `${recipient}.json`), { state, thread_id: recipient });
}

it("surveys registered recipients and parents using each exact decision record", async () => {
  const { layout } = storeFixture((roles) => {
    roles[`${CHIBI}/art`] = {
      conversations: { codex: CHIBI_ART },
      harness: "codex",
      ownership: "active",
      worktree: "../chibis-way-home/.worktrees/art",
    };
    roles["art-kit"] = {
      conversations: { codex: SHARED },
      harness: "codex",
      ownership: "active",
      worktree: "../art-kit",
    };
    roles["delivery-kit"] = {
      conversations: {},
      harness: "codex",
      ownership: "active",
      worktree: "../delivery-kit",
    };
  });
  writeFixtureJson(layout.routeFile, {
    host: GAME,
    schema: 2,
    state: "active",
    targets: [`${GAME}/art`],
  });
  marker(layout, GAME, ART, "pending");
  marker(layout, GAME, CHIBI_ART, "clear");
  marker(layout, CHIBI, CHIBI_ART, "pending");
  marker(layout, GAME, SHARED, "clear");
  expect(decisionDirectory(layout, "missing-game/art")).toBeNull();

  const collect = vi.fn<NativeCollect>(() => {
    const wrongRecipient = {
      item_id: "item-1",
      proof_complete: true,
      proof_refs: [
        {
          kind: "owner_pending_attestation",
          question_index: 0,
          question_item_id: "item-1",
          question_turn_id: TURN,
          recipient: ART,
        },
      ],
      proof_scope: "latest_turn",
      question_index: 0,
      state: "pending",
      title: "Choose an option",
      turn_id: TURN,
    };
    const child = {
      child_id: CHILD,
      complete: true,
      error_code: "serverOverloaded",
      lineage_verified: true,
      parent_id: CHIBI_ART,
      provenance: "native_protocol",
      requires_parent_action: true,
      status: "complete",
      turn_id: TURN,
      turn_status: "failed",
    };
    const health = {
      children: [
        child,
        {
          ...child,
          child_id: HEALTHY_CHILD,
          requires_parent_action: false,
          turn_status: "completed",
        },
      ],
      complete: true,
      provenance: "native_protocol",
      schema_status: "available",
      status: "complete",
    };
    return Promise.resolve({
      collection_budget: {},
      history: {},
      question_state: {
        [ART]: { complete: true, questions: [wrongRecipient], status: "complete" },
        [CHIBI_ART]: { complete: true, questions: [wrongRecipient], status: "complete" },
        [SHARED]: { complete: true, questions: [], status: "complete" },
      },
      worker_health: {
        [ART]: health,
        [CHIBI_ART]: health,
        [SHARED]: {
          ...health,
          children: [
            {
              ...child,
              child_id: UNREADABLE_CHILD,
              complete: false,
              parent_id: SHARED,
              status: "unavailable",
            },
          ],
          complete: false,
          status: "partial",
        },
      },
    });
  });

  const survey = await surveyNative({ collect, env: {}, layout }, 1);
  expect(collect).toHaveBeenCalledExactlyOnceWith({
    decisionRecords: {
      [ART]: { state: "pending", thread_id: ART },
      [CHIBI_ART]: { state: "pending", thread_id: CHIBI_ART },
      [SHARED]: { state: "clear", thread_id: SHARED },
    },
    parents: [ART, SHARED, CHIBI_ART],
    recipients: [ART, SHARED, CHIBI_ART],
    slot: 1,
  });
  expect(survey.questions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        pending: [{ index: 0, item: "item-1", title: "Choose an option", turn: TURN }],
        role: `${GAME}/art`,
        status: "pending",
        visibility: "unknown",
      }),
      expect.objectContaining({
        decisionMarker: { state: "pending" },
        decisionRecord: "pending",
        pending: [],
        role: `${CHIBI}/art`,
        status: "unknown",
      }),
      expect.objectContaining({
        decisionMarker: { state: "clear" },
        decisionRecord: "clear",
        history: { answered: 0, reason: null, status: "complete", unresolved: 0 },
        role: "art-kit",
        status: "unknown",
        visibility: "unknown",
      }),
      expect.objectContaining({ reason: "recipient_held", role: `${GAME}/gameplay` }),
      expect.objectContaining({ reason: "recipient_unbound", role: "delivery-kit" }),
      expect.objectContaining({ reason: "native_harness_unsupported", role: "game-coordinator" }),
    ]),
  );
  expect(survey.workers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        failures: [],
        lineage: { parentNativeId: ART, workerNativeIds: [] },
        reason: "worker_coverage_unverified",
        role: `${GAME}/art`,
        status: "unknown",
      }),
      expect.objectContaining({
        failures: [[CHILD, TURN, "serverOverloaded"]],
        lineage: { parentNativeId: CHIBI_ART, workerNativeIds: [CHILD, HEALTHY_CHILD] },
        role: `${CHIBI}/art`,
        status: "ok",
      }),
      expect.objectContaining({
        lineage: { parentNativeId: SHARED, workerNativeIds: [] },
        role: "art-kit",
        status: "unknown",
        unavailableChildren: [{ id: UNREADABLE_CHILD, reason: "unavailable" }],
      }),
      expect.objectContaining({ lineage: null, role: "game-coordinator" }),
    ]),
  );
});

it("reports only safe field names for a malformed legacy owner marker", async () => {
  const { layout } = storeFixture();
  const directory = join(gameLayout(layout, GAME).busDir, "unblock", "decisions");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${ART}.json`);
  writeFixtureJson(path, {
    resolutions: [
      {
        answer: "Private synthetic answer",
        answer_reference: "legacy-only",
        native_turn_ids: ["legacy-turn"],
        question_item_id: "legacy-item",
      },
    ],
    state: "clear",
    thread_id: ART,
  });
  const before = readFileSync(path);
  const collect = vi.fn<NativeCollect>(() =>
    Promise.resolve({
      collection_budget: {},
      history: {},
      question_state: {},
      worker_health: {},
    }),
  );
  const survey = await surveyNative({ collect, env: {}, layout }, 1);
  const art = survey.questions.find(({ role }) => role === `${GAME}/art`);
  expect(collect.mock.calls[0]?.[0].decisionRecords[ART]).toBeNull();
  expect(art?.decisionRecord).toBe("unknown");
  expect(art?.decisionMarker).toEqual({
    fields: ["question_turn_id", "answer_turn_id", "answer_item_id"],
    reason: "resolution-fields",
    state: "invalid",
  });
  expect(art?.visibility).toBe("unknown");
  expect(readFileSync(path)).toEqual(before);
});

it("reports exact recorded replies as historical proof while visibility stays unknown", async () => {
  const { layout } = storeFixture();
  const directory = join(gameLayout(layout, GAME).busDir, "unblock", "decisions");
  mkdirSync(directory, { recursive: true });
  writeFixtureJson(join(directory, `${ART}.json`), {
    resolutions: [
      {
        answer_item_id: "answer",
        answer_turn_id: TURN,
        question_item_id: "question",
        question_turn_id: TURN,
      },
    ],
    state: "clear",
    thread_id: ART,
  });
  const call = vi.fn((method: string) =>
    Promise.resolve({
      data:
        method === "thread/items/list"
          ? [
              { item: { id: "answer", type: "userMessage" }, threadId: ART, turnId: TURN },
              {
                item: {
                  id: "question",
                  questions: [{ options: ["Yes", "No"], title: "Choose an option" }],
                  type: "agentMessage",
                },
                threadId: ART,
                turnId: TURN,
              },
            ]
          : [],
    }),
  );
  const survey = await surveyNative(
    { connect: () => Promise.resolve({ call, close() {} }), env: {}, layout },
    1,
  );
  expect(survey.questions.find(({ role }) => role === `${GAME}/art`)).toMatchObject({
    decisionRecord: "clear",
    history: { answered: 1, status: "complete", unresolved: 0 },
    status: "unknown",
    visibility: "unknown",
  });
  expect(call.mock.calls.map(([method]) => method)).toEqual([
    "thread/items/list",
    "thread/list",
    "thread/list",
  ]);
});
