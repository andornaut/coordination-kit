import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readWakeFile, wakeFilePath } from "../adapters/claude/wakeFile.ts";
import type { Collected, CollectRequest } from "../adapters/types.ts";
import { EXIT_OK, main } from "../cli.ts";
import { gameLayout, type Layout } from "../layout.ts";
import { Store } from "../store/db.ts";
import {
  prepareFileCheckpoint,
  selectFileCheckpoint,
} from "../store/files/compactionGeneration.ts";
import { activateMigration, prepareMigration } from "../store/files/migration.ts";
import { recordSession } from "../store/handoffs.ts";
import { messageStatus, retainMessage } from "../store/messages.ts";
import { derivedId } from "../store/notices.ts";
import { setPolicyHold } from "../store/policyHolds.ts";
import { openQuestion, releaseHold, setHold } from "../store/questions.ts";
import { storeSend } from "../store/service.ts";
import {
  ART,
  clearDecision,
  COORDINATOR,
  fakeCodex,
  GAME,
  storeFixture,
  TECH,
} from "../store/testStore.ts";
import { blockWork, finishWork, readyWork, startWork } from "../store/work.ts";
import { deliverReview, reviewResultsDir } from "./deliver.ts";
import { coordinationEmit } from "./emit.ts";
import {
  BRIEF_MAX_BYTES,
  BRIEF_MAX_LINES,
  showBrief,
  STALE_WAKE_MS,
  storeReview,
} from "./storeBrief.ts";

const TECH_ROLE = `${GAME}/tech`;
const SLOT = Date.parse("2026-11-18T15:30:00Z") / 1000;
const NEXT = SLOT + 3600;
const LATER = NEXT + 3600;
const SENDER = { CLAUDE_CODE_SESSION_ID: COORDINATOR };
const ACTOR = { nativeId: null, role: "game-coordinator" };

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const ART_ROLE = `${GAME}/art`;

async function storeModeFixture(
  targets: readonly string[] = [TECH_ROLE],
): Promise<{ layout: Layout; root: string; base: string }> {
  const fixture = storeFixture();
  writeFileSync(
    fixture.layout.routeFile,
    JSON.stringify({ host: GAME, schema: 2, state: "active", targets }),
  );
  await Promise.resolve();
  return fixture;
}

async function send(layout: Layout, count: number): Promise<void> {
  for (let n = 1; n <= count; n++) {
    // eslint-disable-next-line no-await-in-loop
    await storeSend(
      { env: SENDER, layout },
      {},
      { body: `Task ${n}.`, id: uuid(n), to: TECH_ROLE },
    );
  }
}

function briefs(
  layout: Layout,
): { id: string; body: string; from_role: string; to_role: string }[] {
  const store = Store.forLayout(layout);
  try {
    return store.db
      .prepare(
        "SELECT id, body, from_role, to_role FROM messages WHERE from_role = 'delivery-kit' ORDER BY sent_seq",
      )
      .all() as unknown as { id: string; body: string; from_role: string; to_role: string }[];
  } finally {
    store.close();
  }
}

it("reopens selected authority when compaction activates during the native survey", async () => {
  const { base, layout, root } = await storeModeFixture();
  execFileSync("git", ["-C", root, "init", "-q", "--initial-branch=main"]);
  writeFileSync(join(root, ".gitignore"), "/var/\n");
  writeFileSync(
    join(layout.varDir, "work-protocol.json"),
    JSON.stringify({ schema: 2, stateRoot: join(base, "prior-state") }),
  );
  const actor = { nativeId: COORDINATOR, role: "game-coordinator" };
  const source = Store.forLayout(layout);
  const start = (store: Store, key: string) =>
    recordSession(store, actor, { cwd: "/fixture", harness: "claude", key, version: "4.1.0" });
  start(source, "anchor");
  source.close();
  const { receipt: cutover } = prepareMigration(
    layout,
    join(base, "backup.db"),
    join(base, "restore.db"),
  );
  activateMigration(layout, cutover.id);

  const old = Store.forLayout(layout);
  try {
    const expired = old.transaction(() => {
      const first = start(old, "historical");
      for (let index = 0; index < 100; index++) {
        start(old, `recent-${index}`);
      }
      return first;
    });
    const target = join(layout.varDir, "coordination");
    const restored = join(base, "restored-journal");
    cpSync(target, restored, { recursive: true });
    const scope = {
      registeredGames: new Set([GAME]),
      registeredRoles: new Set([actor.role]),
      registryRevision: 1,
      verifiedEvidence: {
        head: old.head(),
        messageIds: new Set<string>(),
        registryRevision: 1,
        routineEventSequences: new Set([expired.seq]),
      },
    };
    const prepared = prepareFileCheckpoint(target, restored, scope, cutover.head);
    const collect = vi.fn(async (request: CollectRequest) => {
      await Promise.resolve();
      selectFileCheckpoint(target, restored, prepared, () => scope, cutover.head);
      expect(() => old.transaction(() => {})).toThrow("journal-corrupt");
      return collectedFor(request);
    });

    const game = gameLayout(layout, GAME);
    const context = { collect, env: {}, layout };
    const result = await storeReview(context, game, SLOT);
    expect(result.status).toBe("delivered");
    expect(await storeReview(context, game, SLOT)).toEqual(result);
    expect(collect).toHaveBeenCalledTimes(1);
    const id = derivedId("review-brief", GAME, SLOT);
    expect(showBrief(layout, { game: GAME, slot: SLOT })).toMatchObject({
      messageId: id,
      result,
    });
    expect(briefs(layout)).toEqual([expect.objectContaining({ id })]);
  } finally {
    old.close();
  }
});

describe("stored review brief", () => {
  it("stores one brief per (game, slot) and a repeated call returns the recorded result", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    await send(layout, 2);
    const result = await deliverReview(layout, game, SLOT, undefined, { env: {} });
    const id = derivedId("review-brief", GAME, SLOT);
    expect(result).toEqual({
      detail: `brief ${id} stored for game-coordinator: 2 open, 2 exceptions`,
      reason: null,
      status: "delivered",
    });
    expect(briefs(layout)).toEqual([
      expect.objectContaining({ from_role: "delivery-kit", id, to_role: "game-coordinator" }),
    ]);
    expect(briefs(layout)[0]!.body).toContain("Open messages: 2 (sent 2, delivered 0, retained 0)");
    expect(await deliverReview(layout, game, SLOT, undefined, { env: {} })).toEqual(result);
    // Without the per-slot receipt the store still answers: no second message.
    rmSync(join(reviewResultsDir(game), `${SLOT}.json`));
    expect(await deliverReview(layout, game, SLOT, undefined, { env: {} })).toEqual(result);
    expect(existsSync(join(reviewResultsDir(game), `${SLOT}.json`))).toBe(true);
    expect(briefs(layout)).toHaveLength(1);
  });

  it("records exact user policy hold evidence in the stored review", async () => {
    const { layout } = await storeModeFixture();
    const store = Store.forLayout(layout);
    setPolicyHold(
      store,
      { ...ACTOR, nativeId: COORDINATOR },
      {
        approval: "request-1",
        id: "policy-tech",
        reason: "User paused Tech.",
        scope: `role:${TECH_ROLE}`,
      },
    );
    store.close();
    await deliverReview(layout, gameLayout(layout, GAME), SLOT, undefined, { env: {} });
    expect(showBrief(layout, { game: GAME, slot: SLOT })).toMatchObject({
      counts: { policyHolds: 1 },
      policyHolds: [
        { id: "policy-tech", policy: { approval: "request-1", target: { role: TECH_ROLE } } },
      ],
    });
    expect(briefs(layout)[0]!.body).toContain("Active user policy holds: 1");
  });

  it("writes an accepted Claude wake again once it has gone unpulled for the stale interval", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    await send(layout, 1);
    const seq = (): number | string => {
      const wake = readWakeFile(wakeFilePath(layout, TECH));
      return typeof wake === "string" ? wake : wake.seq;
    };
    expect(seq()).toBe(1);
    const at = (ms: number) => () => new Date(Date.now() + ms).toISOString();
    // Inside the interval the outstanding wake stands.
    await deliverReview(layout, game, SLOT, undefined, { env: {}, now: at(STALE_WAKE_MS / 3) });
    expect(seq()).toBe(1);
    // Past it, the review rearms and the recipient's wake file gets the next seq.
    await deliverReview(layout, game, NEXT, undefined, { env: {}, now: at(STALE_WAKE_MS * 2) });
    expect(seq()).toBe(2);
  });

  it("wakes past a pending question at the review boundary but not past a role hold", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const owner = { nativeId: TECH, role: TECH_ROLE };
    const store = Store.forLayout(layout);
    openQuestion(store, owner, { id: "q-forgotten", title: "Still open?" });
    setHold(store, owner, { id: "h-paused", reason: "Paused.", scope: "role" });
    store.close();
    await send(layout, 1);
    const wake = () => readWakeFile(wakeFilePath(layout, TECH));
    expect(wake()).toBe("absent");
    await deliverReview(layout, game, SLOT, undefined, { env: {} });
    expect(wake()).toBe("absent");
    const again = Store.forLayout(layout);
    releaseHold(again, owner, "h-paused");
    again.close();
    await deliverReview(layout, game, NEXT, undefined, { env: {} });
    expect(wake()).toMatchObject({ seq: 1 });
  });

  it("stores one bounded brief per slot with the new stall count and exact details", async () => {
    const { base, layout, root } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    await send(layout, 100);
    await deliverReview(layout, game, SLOT, undefined, { env: {} });
    await deliverReview(layout, game, NEXT, undefined, { env: {} });
    await deliverReview(layout, game, LATER, undefined, { env: {} });
    const stored = briefs(layout);
    expect(stored.map(({ id }) => id)).toEqual(
      [SLOT, NEXT, LATER].map((slot) => derivedId("review-brief", GAME, slot)),
    );
    const next = stored.find((message) => message.id === derivedId("review-brief", GAME, NEXT))!;
    expect(next.body.split("\n").length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
    expect(Buffer.byteLength(next.body, "utf8")).toBeLessThanOrEqual(BRIEF_MAX_BYTES);
    expect(next.body).toContain("Exceptions: 102");
    expect(next.body).toMatch(
      /- \d+ more: coordination-kit review show --game archies-dog-walks --slot 2026-11-18T16:30:00.000Z/,
    );
    expect(next.body).toContain("100 newly stalled");
    expect(brief(layout, LATER)).not.toContain("New review exceptions:");

    let out = "";
    const io = { cwd: base, env: {}, err: () => {}, out: (text: string) => (out += text) };
    expect(
      await main(io, [
        "--root",
        root,
        "review",
        "show",
        "--game",
        GAME,
        "--slot",
        "2026-11-18T16:30:00Z",
      ]),
    ).toBe(EXIT_OK);
    const shown = JSON.parse(out) as Record<string, unknown>;
    expect(shown).toMatchObject({
      game: GAME,
      kind: "review-show",
      messageId: derivedId("review-brief", GAME, NEXT),
      recipient: "game-coordinator",
      slot: "2026-11-18T16:30:00.000Z",
      decisions: { pending: [], recorded: [] },
      native: {
        questions: expect.arrayContaining([
          expect.objectContaining({ role: ART_ROLE, visibility: "unknown" }),
          expect.objectContaining({ role: "game-coordinator", visibility: "unknown" }),
        ]),
      },
    });
    expect(shown.exceptions).toHaveLength(102);
    expect(shown.body).toBe(next.body);
    out = "";
    expect(await main(io, ["--root", root, "review", "show"])).toBe(EXIT_OK);
    expect(JSON.parse(out)).toMatchObject({ slot: "2026-11-18T17:30:00.000Z" });
  });

  it("surveys the exact unread original without rearming ambiguous Codex acceptance", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const codex = fakeCodex(ART, () => {
      throw new Error("Connection dropped.");
    });
    const ports = { connect: () => Promise.resolve(codex.client) };
    clearDecision(layout, ART);
    const id = uuid(901);
    const sent = await storeSend(
      { env: SENDER, layout, ports },
      {},
      { body: "Uncertain wake.", id, to: ART_ROLE },
    );
    expect(sent.wake.evidence.outcome).toBe("ambiguous");
    await deliverReview(layout, game, SLOT, undefined, { env: {}, wakePorts: ports });
    expect(showBrief(layout, { game: GAME, slot: SLOT })).toMatchObject({
      unread: [{ id, to: ART_ROLE, wake: sent.wake.evidence }],
    });
    expect(codex.adds()).toHaveLength(1);
  });

  it("reports a retained original once its declared boundary is due across two slots", async () => {
    const { base, layout, root } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    await send(layout, 5);
    const held = Store.forLayout(layout, { now: () => "2026-11-18T15:00:00.000Z" });
    const actor = { nativeId: TECH, role: TECH_ROLE };
    const owner = ART_ROLE;
    const reason = "Waiting for the checked capture";
    const nextBoundary = "Next scheduled review, 2026-11-18T11:30:00-05:00";
    try {
      retainMessage(held, actor, uuid(1), { nextBoundary, owner, reason });
      retainMessage(held, actor, uuid(2), {
        nextBoundary: "Until the user clears the hold",
        owner,
        reason,
      });
      retainMessage(held, actor, uuid(3), {
        nextBoundary: "2026-11-18T18:30:00Z",
        owner,
        reason,
      });
      retainMessage(held, actor, uuid(4), { nextBoundary: "Next scheduled review", owner, reason });
      retainMessage(held, actor, uuid(5), {
        nextBoundary: "2026-09-31T16:30:00Z",
        owner,
        reason,
      });
    } finally {
      held.close();
    }
    await deliverReview(layout, game, SLOT, undefined, { env: {} });
    expect(brief(layout, SLOT)).not.toContain("retention-overdue");
    await deliverReview(layout, game, NEXT, undefined, { env: {} });
    await deliverReview(layout, game, LATER, undefined, { env: {} });

    let out = "";
    const io = { cwd: base, env: {}, err: () => {}, out: (text: string) => (out += text) };
    expect(
      await main(io, [
        "--root",
        root,
        "review",
        "show",
        "--game",
        GAME,
        "--slot",
        "2026-11-18T16:30:00Z",
      ]),
    ).toBe(EXIT_OK);
    const shown = JSON.parse(out) as { exceptions: { kind: string }[] };
    expect(shown.exceptions.filter((exception) => exception.kind === "retention-overdue")).toEqual([
      {
        id: uuid(1),
        kind: "retention-overdue",
        retention: { at: "2026-11-18T15:00:00.000Z", nextBoundary, owner, reason },
        role: TECH_ROLE,
        state: "retained",
      },
      expect.objectContaining({ id: uuid(4) }),
    ]);
    const due = brief(layout, NEXT);
    expect(due).toContain("recipient reconciles the original with its owner");
    expect(due).toContain("2 newly overdue retained");
    const later = brief(layout, LATER);
    expect(later).toContain(`- retention-overdue ${uuid(1)}`);
    expect(later).not.toContain("New review exceptions:");
    expect(briefs(layout)).toHaveLength(3);
    const store = Store.forLayout(layout);
    try {
      expect(messageStatus(store, uuid(1))).toMatchObject({
        retention: { nextBoundary, owner, reason },
        state: "retained",
      });
    } finally {
      store.close();
    }
  });

  it("reports a newly stalled ID while an earlier original remains stalled", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    await send(layout, 1);
    await deliverReview(layout, game, SLOT, undefined, { env: {} });
    await send(layout, 2);
    await deliverReview(layout, game, NEXT, undefined, { env: {} });
    await deliverReview(layout, game, LATER, undefined, { env: {} });

    const last = brief(layout, LATER);
    expect(last).toContain(`- stalled ${uuid(1)} to ${TECH_ROLE} (sent, continuing,`);
    expect(last).toContain(`- stalled ${uuid(2)} to ${TECH_ROLE} (sent, newly stalled,`);
    expect(last.indexOf(uuid(2))).toBeLessThan(last.indexOf(uuid(1)));
    expect(brief(layout, NEXT)).toContain("1 newly stalled");
    expect(last).toContain("1 newly stalled");
    expect(briefs(layout)).toHaveLength(3);
  });

  it("skips a game that does not host the route without storing anything", async () => {
    const { layout } = await storeModeFixture();
    const other = gameLayout(layout, "chibis-way-home");
    expect(await deliverReview(layout, other, SLOT, undefined, { env: {} })).toMatchObject({
      reason: "nothing-due",
      status: "skipped",
    });
    expect(briefs(layout)).toEqual([]);
  });
});

describe("coordination events", () => {
  it("go to the store as messages, never to the event outbox", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    coordinationEmit(layout, game, "Archie")("review-stuck", "k-1", "needs reconciliation");
    expect(existsSync(join(game.busDir, "events"))).toBe(false);
    expect(briefs(layout)).toEqual([
      expect.objectContaining({
        body: "Archie bus: needs reconciliation",
        id: derivedId("coordination-event", GAME, "review-stuck", "k-1"),
        to_role: "game-coordinator",
      }),
    ]);
  });
});

/** What the legacy collectors return for one Codex role with a pending question and a failed child. */
function collectedFor(request: CollectRequest): Collected {
  const question = {
    item_id: "item-9",
    kind: "question_tool",
    options: ["Yes", "No"],
    proof_complete: true,
    proof_refs: [
      {
        kind: "owner_pending_attestation",
        question_index: 0,
        question_item_id: "item-9",
        question_turn_id: "turn-9",
        recipient: ART,
      },
    ],
    proof_scope: "latest_turn",
    question_index: 0,
    state: "pending",
    title: "Ship the new map?",
    turn_id: "turn-9",
  };
  const child = {
    child_id: uuid(1001),
    complete: true,
    error_code: "tool_failed",
    lineage_verified: true,
    parent_id: ART,
    requires_parent_action: true,
    turn_id: uuid(1002),
    turn_status: "failed",
  };
  expect(request).toMatchObject({ parents: [ART], recipients: [ART] });
  return {
    collection_budget: { calls_used: 4, max_calls: 256, reason_code: null },
    history: {},
    question_state: { [ART]: { complete: true, questions: [question], status: "complete" } },
    worker_health: {
      [ART]: { children: [child], complete: true, schema_status: "available", status: "complete" },
    },
  };
}

function brief(layout: Layout, slot: number): string {
  return briefs(layout).find((message) => message.id === derivedId("review-brief", GAME, slot))!
    .body;
}

describe("native checks in the stored brief", () => {
  it("reports a pending Codex question every slot and a failed worker once", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const collect = vi.fn((request: CollectRequest) => Promise.resolve(collectedFor(request)));
    const options = { collect, env: {} };
    await deliverReview(layout, game, SLOT, undefined, options);
    const first = brief(layout, SLOT);
    expect(first).toContain(
      "Native prompt visibility: 4 unknown; history: 1 complete, 1 with pending attestations",
    );
    expect(first).toContain("Worker parents: 1 read, 3 unknown, 1 failed children");
    expect(first).toContain(
      '- question-pending archies-dog-walks/art: "Ship the new map?", turn turn-9 item item-9',
    );
    expect(first).toContain(
      `- worker-failed archies-dog-walks/art: child ${uuid(1001)} turn ${uuid(1002)} failed (tool_failed)`,
    );
    await deliverReview(layout, game, NEXT, undefined, options);
    const second = brief(layout, NEXT);
    expect(second).toContain("- question-pending archies-dog-walks/art");
    expect(second).not.toContain("- worker-failed");
    // A repeated slot is answered from the store without another native read.
    await deliverReview(layout, game, NEXT, undefined, options);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("reports unknown only when the native check is unavailable", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const connect = () => Promise.reject(new Error("no control socket"));
    await deliverReview(layout, game, SLOT, undefined, { env: {}, wakePorts: { connect } });
    const body = brief(layout, SLOT);
    expect(body).toContain("Native prompt visibility: 4 unknown; history: 0 complete");
    expect(body).toContain("- question-unknown archies-dog-walks/art: control_unavailable");
    expect(body).toContain("- worker-unknown archies-dog-walks/art: control_unavailable");
  });

  it("keeps current visibility unknown when the native question history is complete", async () => {
    const { layout } = await storeModeFixture([TECH_ROLE, ART_ROLE]);
    const game = gameLayout(layout, GAME);
    const codex = fakeCodex(ART);
    await deliverReview(layout, game, SLOT, undefined, {
      env: {},
      wakePorts: { connect: () => Promise.resolve(codex.client) },
    });
    expect(codex.calls.map((call) => call.method)).toContain("thread/items/list");
    expect(codex.adds()).toEqual([]);
    const body = brief(layout, SLOT);
    expect(body).toContain("Native prompt visibility: 4 unknown; history: 1 complete");
    expect(body).toContain("Exact native prompt inspection unavailable for 1 role.");
    expect(body).not.toContain("- question-unknown archies-dog-walks/art");
    const row = showBrief(layout, { slot: SLOT });
    expect(row.native.questions).toContainEqual(
      expect.objectContaining({
        role: ART_ROLE,
        visibility: "unknown",
        visibilityReason: "exact_unresolved_request_unavailable",
      }),
    );
  });
});

it("shows ready work under its exact recorded parent without reopening finished or blocked work", async () => {
  const { base, layout, root } = await storeModeFixture();
  const store = Store.forLayout(layout);
  const parent = { id: "work-0101", repository: GAME };
  const ready = { id: "work-0102", repository: "art-kit" };
  const unknownParent = { id: "work-0103", repository: "art-kit" };
  const unrecordedParent = { id: "work-0104", repository: GAME };
  const started = { id: "work-0105", repository: "art-kit" };
  const finished = { id: "work-0106", repository: "art-kit" };
  const blocked = { id: "work-0107", repository: "art-kit" };
  const owner = "art-kit";
  try {
    startWork(store, ACTOR, { owner: TECH_ROLE, parent: null, ref: parent });
    for (const ref of [ready, finished, blocked]) {
      startWork(store, ACTOR, { owner, parent, ref });
      readyWork(store, ACTOR, { ref });
    }
    startWork(store, ACTOR, { owner, parent: unrecordedParent, ref: unknownParent });
    readyWork(store, ACTOR, { ref: unknownParent });
    startWork(store, ACTOR, { owner, parent: null, ref: started });
    finishWork(store, ACTOR, { owner, ref: finished });
    blockWork(store, ACTOR, { owner, reason: "Awaiting dependency", ref: blocked });
  } finally {
    store.close();
  }

  await deliverReview(layout, gameLayout(layout, GAME), SLOT, undefined, {
    collect: () =>
      Promise.resolve({
        collection_budget: {},
        history: {},
        question_state: {},
        worker_health: {},
      }),
    env: {},
  });
  const record = showBrief(layout, { slot: SLOT });
  expect(record.counts.readyHandoffs).toBe(2);
  expect(record.readyHandoffs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ...ready, owner, parent: { ...parent, owner: TECH_ROLE } }),
      expect.objectContaining({
        ...unknownParent,
        owner,
        parent: { ...unrecordedParent, owner: null },
      }),
    ]),
  );
  expect(record.body).toContain("Ready work handoffs: 2");
  expect(record.body).toContain(
    `- work-ready art-kit:work-0102 from art-kit: parent ${GAME}:work-0101, owner ${TECH_ROLE}`,
  );
  let out = "";
  const io = { cwd: base, env: {}, err: () => {}, out: (value: string) => (out += value) };
  expect(await main(io, ["--root", root, "review", "show"])).toBe(EXIT_OK);
  expect(JSON.parse(out)).toMatchObject({ readyHandoffs: record.readyHandoffs });
});
