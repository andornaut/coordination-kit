import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readWakeFile, wakeFilePath } from "../adapters/claude/wakeFile.ts";
import type { Collected, CollectRequest } from "../adapters/types.ts";
import { EXIT_OK, main } from "../cli.ts";
import { gameLayout, type Layout } from "../layout.ts";
import { Store } from "../store/db.ts";
import { derivedId } from "../store/notices.ts";
import { storeSend } from "../store/service.ts";
import { ART, COORDINATOR, fakeCodex, GAME, storeFixture, TECH } from "../store/testStore.ts";
import { projectConfig, writeFixtureJson } from "../testFixtures.ts";
import { deliverReview, reviewResultsDir } from "./deliver.ts";
import { coordinationEmit } from "./emit.ts";
import { BRIEF_MAX_BYTES, BRIEF_MAX_LINES, STALE_WAKE_MS } from "./storeBrief.ts";

const TECH_ROLE = `${GAME}/tech`;
const SLOT = Date.parse("2026-11-18T15:30:00Z") / 1000;
const NEXT = SLOT + 3600;
const LATER = NEXT + 3600;
const SENDER = { CLAUDE_CODE_SESSION_ID: COORDINATOR };

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const ART_ROLE = `${GAME}/art`;

async function storeModeFixture(
  targets: readonly string[] = [TECH_ROLE],
  workerParents?: readonly string[],
): Promise<{ layout: Layout; root: string; base: string }> {
  const fixture = storeFixture();
  writeFileSync(
    fixture.layout.routeFile,
    JSON.stringify({ host: GAME, schema: 2, state: "active", targets }),
  );
  if (workerParents !== undefined) {
    const config = projectConfig("Archie") as { reports: Record<string, unknown> };
    config.reports.workerParents = workerParents;
    writeFixtureJson(gameLayout(fixture.layout, GAME).configFile, config);
  }
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

describe("stored review brief", () => {
  it("stores one brief per (game, slot) and a repeated call returns the recorded result", async () => {
    const { layout } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    await send(layout, 2);
    const result = await deliverReview(layout, game, SLOT, undefined, { env: {} });
    const id = derivedId("review-brief", GAME, SLOT);
    expect(result).toEqual({
      detail: `brief ${id} stored for game-coordinator: 2 open, 0 exceptions`,
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

  it("caps the brief at one page, stores review-stuck once per episode and shows the detail", async () => {
    const { base, layout, root } = await storeModeFixture();
    const game = gameLayout(layout, GAME);
    await send(layout, 100);
    await deliverReview(layout, game, SLOT, undefined, { env: {} });
    await deliverReview(layout, game, NEXT, undefined, { env: {} });
    await deliverReview(layout, game, LATER, undefined, { env: {} });
    const stored = briefs(layout);
    const next = stored.find((message) => message.id === derivedId("review-brief", GAME, NEXT))!;
    expect(next.body.split("\n").length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
    expect(Buffer.byteLength(next.body, "utf8")).toBeLessThanOrEqual(BRIEF_MAX_BYTES);
    expect(next.body).toContain("Exceptions: 100");
    expect(next.body).toMatch(
      /- \d+ more: coordination-kit review show --game archies-dog-walks --slot 2026-11-18T16:30:00.000Z/,
    );
    const stuck = stored.filter((message) =>
      message.body.includes("Review needs owner reconciliation"),
    );
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.body).toContain("100 messages unhandled across two distinct slots");

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
    });
    expect(shown.exceptions).toHaveLength(100);
    expect(shown.body).toBe(next.body);
    out = "";
    expect(await main(io, ["--root", root, "review", "show"])).toBe(EXIT_OK);
    expect(JSON.parse(out)).toMatchObject({ slot: "2026-11-18T17:30:00.000Z" });
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
    child_id: "child-1",
    error_code: "tool_failed",
    lineage_verified: true,
    parent_id: ART,
    requires_parent_action: true,
    turn_id: "turn-c1",
    turn_status: "failed",
  };
  expect(request).toMatchObject({ parents: [ART], recipients: [ART], routeMembers: [ART] });
  return {
    collection_budget: { calls_used: 4, max_calls: 256, reason_code: null },
    history: {},
    question_state: { [ART]: { complete: true, questions: [question], status: "complete" } },
    worker_health: { [ART]: { children: [child], complete: true, status: "complete" } },
  };
}

function brief(layout: Layout, slot: number): string {
  return briefs(layout).find((message) => message.id === derivedId("review-brief", GAME, slot))!
    .body;
}

describe("native checks in the stored brief", () => {
  it("reports a pending Codex question every slot and a failed worker once", async () => {
    const { layout } = await storeModeFixture([TECH_ROLE, ART_ROLE], [ART_ROLE]);
    const game = gameLayout(layout, GAME);
    const collect = vi.fn((request: CollectRequest) => Promise.resolve(collectedFor(request)));
    const options = { collect, env: {} };
    await deliverReview(layout, game, SLOT, undefined, options);
    const first = brief(layout, SLOT);
    expect(first).toContain(
      "Codex questions: 1 pending, 0 clear, 0 unknown; worker parents: 1 read, 0 unknown, 1 failed children",
    );
    expect(first).toContain(
      '- question-pending archies-dog-walks/art: "Ship the new map?", turn turn-9 item item-9',
    );
    expect(first).toContain(
      "- worker-failed archies-dog-walks/art: child child-1 turn turn-c1 failed (tool_failed)",
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
    const { layout } = await storeModeFixture([TECH_ROLE, ART_ROLE], [ART_ROLE]);
    const game = gameLayout(layout, GAME);
    const connect = () => Promise.reject(new Error("no control socket"));
    await deliverReview(layout, game, SLOT, undefined, { env: {}, wakePorts: { connect } });
    const body = brief(layout, SLOT);
    expect(body).toContain("Codex questions: 0 pending, 0 clear, 1 unknown");
    expect(body).toContain("- question-unknown archies-dog-walks/art: control_unavailable");
    expect(body).toContain("- worker-unknown archies-dog-walks/art: control_unavailable");
  });

  it("reads question state through the legacy collectors and reports a clear role", async () => {
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
    expect(body).toContain("Codex questions: 0 pending, 1 clear, 0 unknown");
    expect(body).not.toContain("question-unknown");
  });
});
