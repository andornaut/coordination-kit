import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { writeChannelStatus } from "../adapters/claude/channelStatus.ts";
import { wakeFilePath } from "../adapters/claude/wakeFile.ts";
import type { Collected, CollectRequest } from "../adapters/types.ts";
import { main } from "../cli.ts";
import { EXIT_OK } from "../core/cli/io.ts";
import { gameLayout, type Layout } from "../core/configuration/layout.ts";
import { stateRoot } from "../core/configuration/stateRoot.ts";
import { clockAt, TEST_CLOCK, TEST_CONTEXT, TEST_NOW } from "../core/testFixtures.ts";
import { readRegistry, updateRegistry } from "../registry/store.ts";
import { Store } from "../store/db.ts";
import { setPolicyHold } from "../store/decisions/policyHolds.ts";
import { openQuestion, releaseHold, setHold } from "../store/decisions/questions.ts";
import {
  prepareFileCheckpoint,
  selectFileCheckpoint,
} from "../store/files/compaction/generation.ts";
import { messageStatus, retainMessage, sendMessage } from "../store/messages/messages.ts";
import { derivedId, storeNotice } from "../store/messages/notices.ts";
import { storeSend } from "../store/messages/service.ts";
import { recordSession } from "../store/sessions/handoffs.ts";
import { DELIVERY_KIT_ACTOR } from "../store/sessions/identity.ts";
import { ART, COORDINATOR, fakeCodex, GAME, storeFixture, TECH } from "../store/testStore.ts";
import { blockWork, finishWork, readyWork, startWork } from "../store/work-records/work.ts";
import { deliverReview } from "./deliver.ts";
import { coordinationEmit } from "./emit.ts";
import {
  BRIEF_MAX_BYTES,
  BRIEF_MAX_LINES,
  type BriefException,
  composeBrief,
  showBrief,
  storeReview,
} from "./storeBrief.ts";

const TECH_ROLE = `${GAME}/tech`;
const SLOT = Date.parse("2026-11-18T15:30:00Z") / 1000;
const NEXT = SLOT + 3600;
const LATER = NEXT + 3600;
const SENDER = { CLAUDE_CODE_SESSION_ID: COORDINATOR };
const ACTOR = { nativeId: null, role: "game-coordinator" };

/** The seq of the wake file at `path`, or "absent". */
function wakeSeq(path: string): number | "absent" {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { seq: number }).seq
    : "absent";
}

/** The per-slot result `review deliver` records under the game's bus. */
function deliverRecord(game: { readonly busDir: string }, slot: number): string {
  return join(game.busDir, "unblock", "review-deliver", `${slot}.json`);
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const ART_ROLE = `${GAME}/art`;

/** A channel status file for `role` naming `conversation`, as `claude channel` writes it. */
function channelStatus(layout: Layout, role: string, conversation: string): boolean {
  return writeChannelStatus(layout, {
    argv: ["node", "cli.js"],
    conversation,
    distSha256: "0".repeat(64),
    pid: 4242,
    role,
    schema: 2,
    startedAt: "2026-11-18T15:00:00.000Z",
    version: "6.4.0",
  });
}

/** Each active Claude role's channel resolved to its binding, so only the case under test is reported. */
async function storeModeFixture(
  targets: readonly string[] = [TECH_ROLE],
): Promise<{ layout: Layout; root: string; base: string }> {
  const fixture = storeFixture();
  writeFileSync(
    fixture.layout.routeFile,
    JSON.stringify({ host: GAME, schema: 2, state: "active", targets }),
  );
  channelStatus(fixture.layout, "game-coordinator", COORDINATOR);
  channelStatus(fixture.layout, TECH_ROLE, TECH);
  await Promise.resolve();
  return fixture;
}

async function send(layout: Layout, count: number): Promise<void> {
  for (let n = 1; n <= count; n++) {
    // Each message is sent a second after the previous one.
    const sentAt = new Date(Date.parse(TEST_NOW) + n * 1000).toISOString();
    // eslint-disable-next-line no-await-in-loop
    await storeSend(
      { clock: clockAt(sentAt), env: SENDER, layout },
      {},
      { body: `Task ${n}.`, id: uuid(n), to: TECH_ROLE },
    );
  }
}

function briefs(
  layout: Layout,
): { id: string; body: string; from_role: string; to_role: string }[] {
  const store = Store.forLayout(TEST_CONTEXT, layout);
  try {
    return store.index
      .rows("messages")
      .filter(({ from_role }) => from_role === "delivery-kit")
      .sort((a, b) => Number(a.sent_seq) - Number(b.sent_seq))
      .map(({ body, from_role, id, to_role }) => ({
        body: body as string,
        from_role: from_role as string,
        id: id as string,
        to_role: to_role as string,
      }));
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
  const source = Store.forLayout(TEST_CONTEXT, layout);
  const start = (store: Store, key: string) =>
    recordSession(store, actor, { cwd: "/fixture", harness: "claude", key, version: "4.1.0" });
  const cutoverHead = source.head();
  start(source, "anchor");
  source.close();

  const old = Store.forLayout(TEST_CONTEXT, layout);
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
    const prepared = prepareFileCheckpoint(target, restored, scope, cutoverHead);
    const collect = vi.fn(async (request: CollectRequest) => {
      await Promise.resolve();
      selectFileCheckpoint(target, restored, prepared, () => scope, cutoverHead);
      expect(() => old.transaction(() => {})).toThrow("journal-corrupt");
      return collectedFor(request);
    });

    const game = gameLayout(layout, GAME);
    const context = { clock: TEST_CLOCK, collect, env: {}, layout };
    const result = await storeReview(context, game, SLOT);
    expect(result.status).toBe("delivered");
    expect(await storeReview(context, game, SLOT)).toEqual(result);
    expect(collect).toHaveBeenCalledTimes(1);
    const id = derivedId("review-brief", GAME, SLOT);
    expect(showBrief(TEST_CONTEXT, layout, { game: GAME, slot: SLOT })).toMatchObject({
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
    const result = await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, SLOT);
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
    const wake = () => wakeSeq(wakeFilePath(layout, TECH_ROLE));
    expect(wake()).toBe(2);
    expect(await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, SLOT)).toEqual(result);
    expect(wake()).toBe(2);
    // Without the per-slot receipt the store still answers: no second message.
    rmSync(deliverRecord(game, SLOT));
    expect(await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, SLOT)).toEqual(result);
    expect(existsSync(deliverRecord(game, SLOT))).toBe(true);
    expect(briefs(layout)).toHaveLength(1);
    expect(wake()).toBe(2);
  });

  it("resumes an unattempted role without replaying completed or unconfirmed wakes", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const codex = fakeCodex(ART);
    const ports = { connect: () => Promise.resolve(codex.client) };
    await send(layout, 1);
    await storeSend(
      { clock: TEST_CLOCK, env: SENDER, layout, ports },
      {},
      { body: "Art review task.", id: uuid(901), to: ART_ROLE },
    );

    const options = { ...TEST_CONTEXT, env: {}, wakePorts: ports };
    const append = Store.prototype.append;
    const interrupted = vi.spyOn(Store.prototype, "append").mockImplementation(function (
      this: Store,
      input,
    ) {
      if (input.kind === "wake.completed" && input.payload.role === ART_ROLE) {
        throw new Error("Interrupted after the native wake.");
      }
      return append.call(this, input);
    });
    try {
      await expect(deliverReview(options, layout, game, SLOT)).rejects.toThrow(
        "Interrupted after the native wake.",
      );
    } finally {
      interrupted.mockRestore();
    }
    const wakes = () => [
      wakeSeq(wakeFilePath(layout, "game-coordinator")),
      codex.adds().length,
      wakeSeq(wakeFilePath(layout, TECH_ROLE)),
    ];
    expect(existsSync(deliverRecord(game, SLOT))).toBe(false);
    const recorded = showBrief(TEST_CONTEXT, layout, { game: GAME, slot: SLOT });
    expect(recorded.wakePlan?.map(({ role }) => role)).toEqual([
      "game-coordinator",
      ART_ROLE,
      TECH_ROLE,
    ]);
    expect(wakes()).toEqual([1, 2, 1]);

    expect(await deliverReview(options, layout, game, SLOT)).toEqual(recorded.result);
    expect(wakes()).toEqual([1, 2, 2]);
    expect(briefs(layout)).toHaveLength(1);
    expect(await deliverReview(options, layout, game, SLOT)).toEqual(recorded.result);
    expect(wakes()).toEqual([1, 2, 2]);
  });

  it("does not infer unattempted wakes from a legacy brief without a plan", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const messageId = derivedId("review-brief", GAME, SLOT);
    const result = { detail: "Legacy brief.", reason: null, status: "delivered" };
    const recipient = "game-coordinator";
    const store = Store.forLayout(TEST_CONTEXT, layout);
    try {
      storeNotice(store, {
        body: result.detail,
        fallback: result.detail,
        id: messageId,
        to: recipient,
      });
      store.append({
        actor: DELIVERY_KIT_ACTOR,
        key: `review.brief:${GAME}:${SLOT}`,
        kind: "review.brief",
        payload: { game: GAME, messageId, recipient, result, slot: SLOT },
      });
    } finally {
      store.close();
    }

    expect(await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, SLOT)).toEqual(result);
    expect(wakeSeq(wakeFilePath(layout, recipient))).toBe("absent");
    expect(briefs(layout)).toHaveLength(1);
  });

  it("records exact user policy hold evidence in the stored review", async () => {
    const { layout } = await storeModeFixture();
    const store = Store.forLayout(TEST_CONTEXT, layout);
    setPolicyHold(
      store,
      { layout, registry: readRegistry(layout) },
      { ...ACTOR, nativeId: COORDINATOR },
      {
        approval: "request-1",
        id: "policy-tech",
        reason: "User paused Tech.",
        scope: `role:${TECH_ROLE}`,
      },
    );
    store.close();
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, gameLayout(layout, GAME), SLOT);
    expect(showBrief(TEST_CONTEXT, layout, { game: GAME, slot: SLOT })).toMatchObject({
      counts: { policyHolds: 1 },
      policyHolds: [
        { id: "policy-tech", policy: { approval: "request-1", target: { role: TECH_ROLE } } },
      ],
    });
    expect(briefs(layout)[0]!.body).toContain("Active user policy holds: 1");
  });

  it("sends one wake per recipient with unread originals through each harness adapter", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const codex = fakeCodex(ART);
    const ports = { connect: () => Promise.resolve(codex.client) };
    await send(layout, 2);
    for (const n of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      await storeSend(
        { clock: TEST_CLOCK, env: SENDER, layout, ports },
        {},
        { body: `Art ${n}.`, id: uuid(800 + n), to: ART_ROLE },
      );
    }
    await storeSend(
      { clock: TEST_CLOCK, env: SENDER, layout },
      {},
      { body: "Held.", id: uuid(900), to: `${GAME}/gameplay` },
    );
    const seq = (role: string) => wakeSeq(wakeFilePath(layout, role));
    expect([seq(TECH_ROLE), codex.adds().length]).toEqual([1, 1]);
    await deliverReview({ ...TEST_CONTEXT, env: {}, wakePorts: ports }, layout, game, SLOT);
    // Exactly one more wake each, the brief's recipient included; the held role gets none.
    expect([seq(TECH_ROLE), codex.adds().length, seq("game-coordinator")]).toEqual([2, 2, 1]);
    expect(seq(`${GAME}/gameplay`)).toBe("absent");
    await deliverReview({ ...TEST_CONTEXT, env: {}, wakePorts: ports }, layout, game, NEXT);
    expect([seq(TECH_ROLE), codex.adds().length, seq("game-coordinator")]).toEqual([3, 3, 2]);
    expect(seq(`${GAME}/gameplay`)).toBe("absent");
  });

  it("wakes past a pending question at the review boundary but not past a role hold", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const owner = { nativeId: TECH, role: TECH_ROLE };
    const store = Store.forLayout(TEST_CONTEXT, layout);
    openQuestion(store, owner, { id: "q-forgotten", title: "Still open?" });
    setHold(store, owner, { id: "h-paused", reason: "Paused.", scope: "role" });
    store.close();
    await send(layout, 1);
    const wake = () => wakeSeq(wakeFilePath(layout, TECH_ROLE));
    expect(wake()).toBe("absent");
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, SLOT);
    expect(wake()).toBe("absent");
    const again = Store.forLayout(TEST_CONTEXT, layout);
    releaseHold(again, owner, "h-paused");
    again.close();
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, NEXT);
    expect(wake()).toBe(1);
  });

  it("stores one bounded brief per slot with the new stall count and exact details", async () => {
    const { base, layout, root } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    await send(layout, 1);
    // Seed the remaining originals together; this case verifies review output, not send retries.
    let second = 1;
    const seeded = Store.forLayout(
      { ...TEST_CONTEXT, clock: () => new Date(Date.parse(TEST_NOW) + second * 1000) },
      layout,
    );
    try {
      seeded.transaction(() => {
        for (second = 2; second <= 100; second++) {
          sendMessage(
            seeded,
            { nativeId: COORDINATOR, role: "game-coordinator" },
            { body: `Task ${second}.`, id: uuid(second), intent: "queue", to: TECH_ROLE },
          );
        }
      });
    } finally {
      seeded.close();
    }
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, SLOT);
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, NEXT);
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, LATER);
    const stored = briefs(layout);
    expect(stored.map(({ id }) => id)).toEqual(
      [SLOT, NEXT, LATER].map((slot) => derivedId("review-brief", GAME, slot)),
    );
    const next = stored.find((message) => message.id === derivedId("review-brief", GAME, NEXT))!;
    expect(next.body.split("\n").length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
    expect(Buffer.byteLength(next.body, "utf8")).toBeLessThanOrEqual(BRIEF_MAX_BYTES);
    expect(next.body).toContain("Exceptions: 102");
    // The 100 stalled originals share one line; review show keeps every exact ID.
    expect(next.body).toMatch(
      new RegExp(
        `- stalled ${TECH_ROLE}: 100 open across two slots \\(100 newly stalled\\), ` +
          `oldest ${uuid(1)}, age \\d+[mhd]\n`,
      ),
    );
    expect(next.body).not.toContain(uuid(50));
    expect(next.body).not.toContain(" more: ");
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
    expect(shown.exceptions).toContainEqual(
      expect.objectContaining({ id: uuid(50), kind: "stalled", role: TECH_ROLE }),
    );
    expect(shown.body).toBe(next.body);
    out = "";
    expect(await main(io, ["--root", root, "review", "show"])).toBe(EXIT_OK);
    expect(JSON.parse(out)).toMatchObject({ slot: "2026-11-18T17:30:00.000Z" });
  });

  it("records the exact unread original before the review wakes again", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const codex = fakeCodex(ART, () => {
      throw new Error("Connection dropped.");
    });
    const ports = { connect: () => Promise.resolve(codex.client) };
    const id = uuid(901);
    const sent = await storeSend(
      { clock: TEST_CLOCK, env: SENDER, layout, ports },
      {},
      { body: "Uncertain wake.", id, to: ART_ROLE },
    );
    expect(sent.wake.evidence.outcome).toBe("ambiguous");
    await deliverReview({ ...TEST_CONTEXT, env: {}, wakePorts: ports }, layout, game, SLOT);
    expect(showBrief(TEST_CONTEXT, layout, { game: GAME, slot: SLOT })).toMatchObject({
      unread: [{ id, to: ART_ROLE, wake: sent.wake.evidence }],
    });
    // The queue shows no earlier wake, so the review's one wake is not a duplicate.
    expect(codex.adds()).toHaveLength(2);
  });

  it("reports a retained original once its declared boundary is due across two slots", async () => {
    const { base, layout, root } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    await send(layout, 5);
    const held = Store.forLayout(
      { ...TEST_CONTEXT, clock: clockAt("2026-11-18T15:00:00.000Z") },
      layout,
    );
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
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, SLOT);
    expect(brief(layout, SLOT)).not.toContain("retention-overdue");
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, NEXT);
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, LATER);

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
        sentAt: expect.any(String),
        state: "retained",
      },
      expect.objectContaining({ id: uuid(4) }),
    ]);
    const due = brief(layout, NEXT);
    expect(due).toContain(`- retention-overdue ${TECH_ROLE}: 2 due, oldest ${uuid(1)}, age `);
    expect(due).toContain("recipient reconciles each original with its owner");
    expect(due).toContain("2 newly overdue retained");
    const later = brief(layout, LATER);
    expect(later).toContain(`- retention-overdue ${TECH_ROLE}: 2 due, oldest ${uuid(1)}`);
    expect(later).not.toContain("New review exceptions:");
    expect(briefs(layout)).toHaveLength(3);
    const store = Store.forLayout(TEST_CONTEXT, layout);
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
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, SLOT);
    await send(layout, 2);
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, NEXT);
    await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, game, LATER);

    const last = brief(layout, LATER);
    expect(last).toContain(
      `- stalled ${TECH_ROLE}: 2 open across two slots (1 newly stalled), oldest ${uuid(1)}, age `,
    );
    expect(last).not.toContain(uuid(2));
    expect(brief(layout, NEXT)).toContain("1 newly stalled");
    expect(last).toContain("1 newly stalled");
    expect(briefs(layout)).toHaveLength(3);
  });

  it("skips a game that does not host the route without storing anything", async () => {
    const { layout } = await storeModeFixture();
    const other = gameLayout(layout, "chibis-way-home");
    expect(await deliverReview({ ...TEST_CONTEXT, env: {} }, layout, other, SLOT)).toMatchObject({
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
    coordinationEmit(
      TEST_CONTEXT,
      layout,
      game,
      "Archie",
    )("review-stuck", "k-1", "needs reconciliation");
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
function collectedFor(
  request: CollectRequest,
  workerStatus: "complete" | "partial" = "complete",
  attempted?: string,
): Collected {
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
    child_id: attempted ?? uuid(1001),
    complete: true,
    error_code: "tool_failed",
    lineage_verified: true,
    parent_id: ART,
    provenance: "native_protocol",
    requires_parent_action: true,
    status: "complete",
    turn_id: uuid(1002),
    turn_status: "failed",
  };
  expect(request).toMatchObject({ parents: [ART], recipients: [ART] });
  return {
    collection_budget: { calls_used: 4, max_calls: 256, reason_code: null },
    history: {},
    question_state: { [ART]: { complete: true, questions: [question], status: "complete" } },
    worker_health: {
      [ART]: {
        children: [child],
        complete: workerStatus === "complete",
        diagnostics: workerStatus === "partial" ? ["native_timeout"] : [],
        ...(attempted === undefined ? {} : { next_child_after: attempted }),
        provenance: "native_protocol",
        schema_status: "available",
        status: workerStatus,
      },
    },
  };
}

function brief(layout: Layout, slot: number): string {
  return briefs(layout).find((message) => message.id === derivedId("review-brief", GAME, slot))!
    .body;
}

describe("native checks in the stored brief", () => {
  it("seeds a legacy cursor, advances on a new attempt and survives a stalled slot", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const attempted = uuid(1003);
    const collect = vi.fn((request: CollectRequest) => {
      if (request.slot === SLOT) {
        return Promise.resolve(collectedFor(request));
      }
      if (request.slot === NEXT) {
        return Promise.resolve(collectedFor(request, "complete", attempted));
      }
      return Promise.resolve({
        collection_budget: {},
        history: {},
        question_state: {},
        worker_health: {},
      });
    });
    const options = { ...TEST_CONTEXT, collect, env: {} };
    const workerAt = (slot: number) =>
      showBrief(TEST_CONTEXT, layout, { slot }).native.workers.find(
        ({ role }) => role === ART_ROLE,
      );

    await deliverReview(options, layout, game, SLOT);
    expect(workerAt(SLOT)?.cursor).toBeUndefined();
    await deliverReview(options, layout, game, NEXT);
    expect(collect.mock.calls[1]?.[0].workerCursors).toEqual({ [ART]: uuid(1001) });
    expect(workerAt(NEXT)?.cursor).toEqual({ afterChildId: attempted, parentNativeId: ART });
    await deliverReview(options, layout, game, NEXT);
    expect(collect).toHaveBeenCalledTimes(2);
    await deliverReview(options, layout, game, LATER);
    expect(collect.mock.calls[2]?.[0].workerCursors).toEqual({ [ART]: attempted });
    expect(workerAt(LATER)).toMatchObject({
      coverage: "unavailable",
      cursor: { afterChildId: attempted, parentNativeId: ART },
      failures: [],
      lineage: null,
    });

    const replacement = uuid(1010);
    updateRegistry(TEST_CLOCK, layout, 1, (draft) => {
      draft.roles[ART_ROLE]!.conversations.codex = replacement;
    });
    const reboundSlot = LATER + 3600;
    await deliverReview(options, layout, game, reboundSlot);
    expect(collect.mock.calls[3]?.[0]).toMatchObject({ parents: [replacement] });
    expect(collect.mock.calls[3]?.[0].workerCursors).toBeUndefined();
    expect(workerAt(reboundSlot)?.cursor).toBeUndefined();
  });

  it("reports a pending Codex question every slot and a failed worker once", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const collect = vi.fn((request: CollectRequest) => Promise.resolve(collectedFor(request)));
    const options = { collect, env: {} };
    await deliverReview({ ...TEST_CONTEXT, ...options }, layout, game, SLOT);
    const first = brief(layout, SLOT);
    expect(first).toContain(
      "Native prompt visibility: 4 unknown; history: 1 complete, 1 with pending attestations",
    );
    expect(first).toContain("Worker parents: 1 complete, 0 partial, 3 unknown, 1 failed children");
    expect(first).toContain(
      '- question-pending archies-dog-walks/art: "Ship the new map?", turn turn-9 item item-9',
    );
    expect(first).toContain(
      `- worker-failed archies-dog-walks/art: child ${uuid(1001)} turn ${uuid(1002)} failed (tool_failed)`,
    );
    await deliverReview({ ...TEST_CONTEXT, ...options }, layout, game, NEXT);
    const second = brief(layout, NEXT);
    expect(second).toContain("- question-pending archies-dog-walks/art");
    expect(second).not.toContain("- worker-failed");
    // A repeated slot is answered from the store without another native read.
    await deliverReview({ ...TEST_CONTEXT, ...options }, layout, game, NEXT);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it("reports retained verified reads as partial and preserves the incomplete count", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const collect = (request: CollectRequest) => Promise.resolve(collectedFor(request, "partial"));
    await deliverReview({ ...TEST_CONTEXT, collect, env: {} }, layout, game, SLOT);
    const body = brief(layout, SLOT);
    expect(body).toContain("Worker parents: 0 complete, 1 partial, 3 unknown, 1 failed children");
    expect(body).toContain(
      "- worker-unknown archies-dog-walks/art: verified partial coverage (native_timeout)",
    );
    const row = showBrief(TEST_CONTEXT, layout, { slot: SLOT });
    expect(row.counts.native).toMatchObject({
      workers: { failed: 1, ok: 0, partial: 1, unknown: 4 },
    });
    expect(row.native.workers).toContainEqual(
      expect.objectContaining({
        coverage: "partial",
        failures: [[uuid(1001), uuid(1002), "tool_failed"]],
        role: ART_ROLE,
        status: "unknown",
      }),
    );
  });

  it("reports unknown only when the native check is unavailable", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const connect = () => Promise.reject(new Error("no control socket"));
    await deliverReview({ ...TEST_CONTEXT, env: {}, wakePorts: { connect } }, layout, game, SLOT);
    const body = brief(layout, SLOT);
    expect(body).toContain("Native prompt visibility: 4 unknown; history: 0 complete");
    expect(body).toContain("- question-unknown archies-dog-walks/art: control_unavailable");
    expect(body).toContain("- worker-unknown archies-dog-walks/art: control_unavailable");
    expect(showBrief(TEST_CONTEXT, layout, { slot: SLOT }).native.workers).toContainEqual(
      expect.objectContaining({ coverage: "unavailable", role: ART_ROLE, status: "unknown" }),
    );
  });

  it("keeps current visibility unknown when the native question history is complete", async () => {
    const { layout } = await storeModeFixture([TECH_ROLE, ART_ROLE]);
    const game = gameLayout(layout, GAME);
    const codex = fakeCodex(ART);
    await deliverReview(
      { ...TEST_CONTEXT, env: {}, wakePorts: { connect: () => Promise.resolve(codex.client) } },
      layout,
      game,
      SLOT,
    );
    expect(codex.calls.map((call) => call.method)).toContain("thread/items/list");
    expect(codex.adds()).toEqual([]);
    const body = brief(layout, SLOT);
    expect(body).toContain("Native prompt visibility: 4 unknown; history: 1 complete");
    expect(body).toContain("Exact native prompt inspection unavailable for 1 role.");
    expect(body).not.toContain("- question-unknown archies-dog-walks/art");
    const row = showBrief(TEST_CONTEXT, layout, { slot: SLOT });
    expect(row.native.questions).toContainEqual(
      expect.objectContaining({
        role: ART_ROLE,
        visibility: "unknown",
        visibilityReason: "exact_unresolved_request_unavailable",
      }),
    );
  });
});

describe("channel status in the stored brief", () => {
  const STALE = "e1e1e1e1-0000-4000-8000-000000000000";
  const channelExceptions = (layout: Layout, slot: number) =>
    brief(layout, slot)
      .split("\n")
      .filter((line) => line.startsWith("- channel-"));
  const collect = () =>
    Promise.resolve({ collection_budget: {}, history: {}, question_state: {}, worker_health: {} });

  it("reports each active Claude role whose channel is missing or on another conversation", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    rmSync(join(stateRoot(layout), "channel", "roles", `${TECH_ROLE}.json`));
    await deliverReview({ ...TEST_CONTEXT, collect, env: {} }, layout, game, SLOT);
    // The held gameplay role and the Codex art role are not reported.
    expect(channelExceptions(layout, SLOT)).toEqual([
      `- channel-unresolved ${TECH_ROLE}: no channel status`,
    ]);
    channelStatus(layout, TECH_ROLE, STALE);
    await deliverReview({ ...TEST_CONTEXT, collect, env: {} }, layout, game, NEXT);
    expect(channelExceptions(layout, NEXT)).toEqual([
      `- channel-unresolved ${TECH_ROLE}: channel on e1e1e1e1`,
    ]);
    expect(showBrief(TEST_CONTEXT, layout, { slot: NEXT }).native.channels).toEqual([
      expect.objectContaining({
        binding: TECH,
        conversation: STALE,
        pid: 4242,
        role: TECH_ROLE,
        status: "stale",
      }),
      expect.objectContaining({
        binding: COORDINATOR,
        conversation: COORDINATOR,
        role: "game-coordinator",
        status: "current",
      }),
    ]);
    channelStatus(layout, TECH_ROLE, TECH);
    await deliverReview({ ...TEST_CONTEXT, collect, env: {} }, layout, game, LATER);
    expect(channelExceptions(layout, LATER)).toEqual([]);
    expect(showBrief(TEST_CONTEXT, layout, { slot: LATER }).counts.native).toMatchObject({
      channels: { current: 2, missing: 0, stale: 0, unreadable: 0 },
    });
  });

  it("reports unknown when the channel status cannot be read", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    const roles = join(stateRoot(layout), "channel", "roles");
    rmSync(roles, { recursive: true });
    // A file where the status directory belongs: every read fails with ENOTDIR.
    writeFileSync(roles, "");
    const result = await deliverReview({ ...TEST_CONTEXT, collect, env: {} }, layout, game, SLOT);
    expect(result?.status).toBe("delivered");
    expect(channelExceptions(layout, SLOT)).toEqual([
      `- channel-unknown ${TECH_ROLE}: channel status unreadable`,
      "- channel-unknown game-coordinator: channel status unreadable",
    ]);
  });
});

describe("brief exceptions", () => {
  const counts = (surveyed: number) => ({
    byRole: {},
    completes: 0,
    decisions: { pending: 0, recorded: 0 },
    native: {
      claudeRoles: 3,
      questions: {
        historyComplete: 0,
        pending: 0,
        surveyed,
        unavailableCapability: 0,
        visibilityUnknown: 4,
      },
      workers: { failed: 0, ok: 0, unknown: 0 },
    },
    open: 0,
    policyHolds: 0,
    readyHandoffs: 0,
    runnerEvents: 0,
    states: { delivered: 0, retained: 0, sent: 0 },
    unconfirmed: 0,
    unread: 0,
    wakes: { ambiguous: 0, failed: 0, guarded: 0, outstanding: 0 },
  });
  const game = () => gameLayout(storeFixture().layout, GAME);
  const at = (minutes: number) => new Date((SLOT - minutes * 60) * 1000).toISOString();

  it("groups stalled and overdue originals per recipient with count, oldest ID and age", () => {
    const exceptions: BriefException[] = [
      {
        id: uuid(3),
        kind: "stalled",
        newlyStalled: true,
        role: TECH_ROLE,
        sentAt: at(30),
        state: "sent",
      },
      { id: uuid(4), kind: "stalled", role: ART_ROLE, sentAt: at(3 * 24 * 60), state: "sent" },
      { id: uuid(1), kind: "stalled", role: TECH_ROLE, sentAt: at(5 * 60), state: "delivered" },
      {
        id: uuid(5),
        kind: "retention-overdue",
        role: TECH_ROLE,
        sentAt: at(90),
        state: "retained",
      },
      { detail: "recipient-held", kind: "wake-guarded", role: ART_ROLE },
    ];
    const lines = composeBrief(game(), SLOT, { counts: counts(1), exceptions }).split("\n");
    expect(lines).toContain("Worker parents: 0 complete, 0 partial, 0 unknown, 0 failed children");
    expect(lines.filter((line) => line.startsWith("- "))).toEqual([
      `- stalled ${TECH_ROLE}: 2 open across two slots (1 newly stalled), oldest ${uuid(1)}, age 5h`,
      `- stalled ${ART_ROLE}: 1 open across two slots (0 newly stalled), oldest ${uuid(4)}, age 3d`,
      `- retention-overdue ${TECH_ROLE}: 1 due, oldest ${uuid(5)}, age 90m; ` +
        "recipient reconciles each original with its owner",
      `- wake-guarded ${ART_ROLE}: recipient-held`,
    ]);
    expect(lines).toContain("Exceptions: 5");
  });

  it("counts every exception a cut-off line stands for", () => {
    const exceptions: BriefException[] = Array.from({ length: 80 }, (_, n) => ({
      detail: "recipient-held",
      kind: "wake-guarded",
      role: `role-${n}`,
    }));
    const body = composeBrief(game(), SLOT, { counts: counts(1), exceptions });
    const shown = body.split("\n").filter((line) => line.startsWith("- wake-guarded")).length;
    expect(body).toContain(`- ${80 - shown} more: coordination-kit review show`);
    expect(body.split("\n").length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
  });

  it("prints native prompt visibility only when a supported survey exists", () => {
    expect(composeBrief(game(), SLOT, { counts: counts(0), exceptions: [] })).not.toContain(
      "Native prompt visibility",
    );
    expect(composeBrief(game(), SLOT, { counts: counts(1), exceptions: [] })).toContain(
      "Native prompt visibility: 4 unknown",
    );
  });
});

it("shows ready work under its exact recorded parent without reopening finished or blocked work", async () => {
  const { base, layout, root } = await storeModeFixture();
  const store = Store.forLayout(TEST_CONTEXT, layout);
  const parent = { id: "work-0101", repository: GAME };
  const ready = { id: "work-0102", repository: "art-kit" };
  const unknownParent = { id: "work-0103", repository: "art-kit" };
  const unrecordedParent = { id: "work-0104", repository: GAME };
  const started = { id: "work-0105", repository: "art-kit" };
  const finished = { id: "work-0106", repository: "art-kit" };
  const blocked = { id: "work-0107", repository: "art-kit" };
  const superseded = { id: "work-0108", repository: "art-kit" };
  const cancelled = { id: "work-0109", repository: "art-kit" };
  const owner = "art-kit";
  try {
    startWork(store, ACTOR, { owner: TECH_ROLE, parent: null, ref: parent });
    for (const ref of [ready, finished, blocked, superseded, cancelled]) {
      startWork(store, ACTOR, { owner, parent, ref });
      readyWork(store, ACTOR, { ref });
    }
    startWork(store, ACTOR, { owner, parent: unrecordedParent, ref: unknownParent });
    readyWork(store, ACTOR, { ref: unknownParent });
    startWork(store, ACTOR, { owner, parent: null, ref: started });
    finishWork(store, ACTOR, { owner, ref: finished });
    finishWork(store, ACTOR, {
      owner,
      ref: superseded,
      status: "superseded",
      successors: ["work-0110"],
    });
    finishWork(store, ACTOR, { owner, ref: cancelled, status: "cancelled" });
    blockWork(store, ACTOR, { owner, reason: "Awaiting dependency", ref: blocked });
  } finally {
    store.close();
  }

  await deliverReview(
    {
      ...TEST_CONTEXT,
      collect: () =>
        Promise.resolve({
          collection_budget: {},
          history: {},
          question_state: {},
          worker_health: {},
        }),
      env: {},
    },
    layout,
    gameLayout(layout, GAME),
    SLOT,
  );
  const record = showBrief(TEST_CONTEXT, layout, { slot: SLOT });
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
