import { describe, expect, it } from "vitest";

import { eventHash } from "../eventCodec.ts";
import { GENESIS, type JsonObject, type StoredEvent } from "../types.ts";
import { type CompactionScope, planFileCompaction } from "./compactionPlan.ts";

const SENDER = "sample-kit";
const FIRST = "sample-game/art";
const SECOND = "sample-game/tech";
const AT = "2026-11-21T00:00:00.000Z";
const SCOPE = {
  registeredGames: new Set(["sample-game"]),
  registeredRoles: new Set([FIRST, SECOND, SENDER]),
  registryRevision: 7,
};

function journal() {
  const events: StoredEvent[] = [];
  const append = (kind: string, role: string, payload: JsonObject) => {
    const next = {
      actor: { nativeId: typeof payload.nativeId === "string" ? payload.nativeId : null, role },
      at: AT,
      key: `${kind}:${events.length}`,
      kind,
      payload,
      prevHash: events.at(-1)?.hash ?? GENESIS,
      seq: events.length + 1,
    };
    const event = { ...next, hash: eventHash(next) };
    events.push(event);
    return event.seq;
  };
  const send = (id: string, to: string, extra: JsonObject = {}) =>
    append("msg.sent", SENDER, { body: `café ${id}`, from: SENDER, id, to, ...extra });
  const close = (id: string, to: string) => append("msg.closed", to, { id, state: "handled" });
  const countCloses = (count: number, to: string) => {
    for (let index = 0; index < count; index += 1) {
      const id = `${to}-${index}`;
      send(id, to);
      close(id, to);
    }
  };
  return { append, close, countCloses, events, send };
}

function proof(
  events: readonly StoredEvent[],
  messageIds: readonly string[] = [],
  sequences: readonly number[] = [],
): NonNullable<CompactionScope["verifiedEvidence"]> {
  const { hash, seq } = events.at(-1)!;
  return {
    head: { hash, seq },
    messageIds: new Set(messageIds),
    registryRevision: SCOPE.registryRevision,
    routineEventSequences: new Set(sequences),
  };
}

describe("file compaction plan", () => {
  it("counts the latest one hundred exact closes per recipient in close sequence", () => {
    const { append, close, countCloses, events, send } = journal();
    send("early-send-late-close", FIRST);
    send("late-send-early-close", FIRST);
    close("late-send-early-close", FIRST);
    countCloses(99, FIRST);
    append("msg.closed", FIRST, { id: "early-send-late-close", state: "superseded" });
    countCloses(101, SECOND);

    const defaultPlan = planFileCompaction(events, SCOPE);
    expect(defaultPlan.diskSavingsBytes).toBeNull();
    const first = defaultPlan.streams.find((stream) => stream.source === FIRST)!;
    expect(first.total.count).toBe(101);
    expect(first.outsideWindow.count).toBe(1);
    expect(first.eligible.count).toBe(0);
    expect(first.protected).toMatchObject([
      { count: 1, reason: "replacement-unverified" },
      { count: 100, reason: "within-window" },
    ]);

    const plan = planFileCompaction(events, {
      ...SCOPE,
      verifiedEvidence: proof(events, ["late-send-early-close", "early-send-late-close"]),
    });
    const older = plan.streams.find((stream) => stream.source === FIRST)!.eligible;
    expect(older.count).toBe(1);
    expect(older.bodyBytes).toBe(Buffer.byteLength("café late-send-early-close"));
    expect(older.payloadBytes).toBeGreaterThan(older.bodyBytes);
    expect(older.metadataBytes).toBeGreaterThan(0);
    expect(older.journalBytes).toBe(older.payloadBytes + older.metadataBytes);
    expect(plan.streams.find((stream) => stream.source === SECOND)!.outsideWindow.count).toBe(1);
    expect(JSON.stringify(plan)).not.toContain("late-send-early-close");
  });

  it("keeps unresolved delivery, retained originals, unproved ownership and live references", () => {
    const { append, close, countCloses, events, send } = journal();
    send("referenced", FIRST);
    close("referenced", FIRST);
    send("referenced-by-ambiguity", FIRST);
    close("referenced-by-ambiguity", FIRST);
    send("ambiguous-wake", FIRST, {
      links: [{ kind: "message", ref: "referenced-by-ambiguity" }],
    });
    append("wake.claimed", "system", { messages: ["ambiguous-wake"], role: FIRST, wake: "wake" });
    append("wake.completed", "system", { outcome: "ambiguous", role: FIRST, wake: "wake" });
    close("ambiguous-wake", FIRST);
    send("pending-reminder", FIRST);
    append("reminder.claimed", "game-coordinator", {
      id: "reminder",
      originals: [{ id: "pending-reminder" }],
      role: FIRST,
    });
    close("pending-reminder", FIRST);
    countCloses(100, FIRST);
    send("retained", SECOND, { links: [{ kind: "message", ref: "referenced" }] });
    append("msg.retained", SECOND, { id: "retained", reason: "Wait for a decision" });
    send("unknown-role", "unknown");
    append("msg.imported", "system", {
      body: "old",
      from: SENDER,
      id: "legacy",
      state: "handled",
      to: FIRST,
    });

    const plan = planFileCompaction(events, {
      ...SCOPE,
      verifiedEvidence: proof(events, [
        "ambiguous-wake",
        "pending-reminder",
        "referenced",
        "legacy",
      ]),
    });
    const {
      eligible,
      outsideWindow,
      protected: reasons,
    } = plan.streams.find((stream) => stream.source === FIRST)!;
    expect(outsideWindow.count).toBe(4);
    expect(eligible.count).toBe(0);
    expect(reasons).toMatchObject([
      { count: 1, reason: "close-sequence-unavailable" },
      { count: 2, reason: "delivery-unresolved" },
      { count: 2, reason: "open-message-reference" },
      { count: 100, reason: "within-window" },
    ]);
    expect(plan.streams.find((stream) => stream.source === SECOND)?.protected).toMatchObject([
      { count: 1, reason: "retained-message" },
    ]);
    expect(plan.streams.find((stream) => stream.source === "unknown")?.protected).toMatchObject([
      { count: 1, reason: "ownership-unverified" },
    ]);
  });

  it("keeps other events and requires exact checkpoint coverage for aged routine events", () => {
    const { append, events } = journal();
    const session = { nativeId: "00000000-0000-4000-8000-000000000000", role: FIRST };
    const tick = {
      game: "sample-game",
      kind: "runner",
      sha: null,
      status: null,
      type: "scheduled-status",
      work: null,
    };
    const oldestTick = append("bus.event", "delivery-kit", tick);
    const oldestSession = append("session.started", FIRST, session);
    for (let index = 0; index < 100; index += 1) {
      append("session.started", FIRST, session);
      append("bus.event", "delivery-kit", tick);
    }
    append("bus.event", "delivery-kit", { ...tick, type: "runner.started" });
    append("notice.consumed", FIRST, { id: "unknown-new-kind" });
    const evidence = proof(events, [], [oldestTick, oldestSession, events.length]);
    for (const verifiedEvidence of [undefined, { ...evidence, registryRevision: 6 }]) {
      const plan = planFileCompaction(
        events,
        verifiedEvidence === undefined ? SCOPE : { ...SCOPE, verifiedEvidence },
      );
      expect(plan.streams.filter((stream) => stream.outsideWindow.count > 0)).toMatchObject([
        {
          eligible: { count: 0 },
          protected: [
            { count: 1, reason: "checkpoint-unverified" },
            { count: 100, reason: "within-window" },
          ],
        },
        {
          eligible: { count: 0 },
          protected: [
            { count: 1, reason: "checkpoint-unverified" },
            { count: 100, reason: "within-window" },
          ],
        },
      ]);
    }
    const qualified = planFileCompaction(events, { ...SCOPE, verifiedEvidence: evidence });
    expect(qualified.streams.filter(({ kind }) => kind === "routine")).toMatchObject([
      { eligible: { count: 1 }, kind: "routine", source: "runner:sample-game" },
      { eligible: { count: 1 }, kind: "routine", source: `session:${FIRST}` },
    ]);
    expect(
      qualified.streams.find(({ source }) => source === "notice.consumed")?.protected,
    ).toMatchObject([{ count: 1, reason: "protected-event-kind" }]);

    append("hold.set", FIRST, { id: "new-active-hold" });
    expect(
      planFileCompaction(events, { ...SCOPE, verifiedEvidence: evidence }).streams.every(
        ({ eligible }) => eligible.count === 0,
      ),
    ).toBe(true);
    expect(() => planFileCompaction(events.slice(1), SCOPE)).toThrow("compaction-snapshot-order");
  });

  it("protects operational bodies and waits for exact native delivery consumption", () => {
    const { append, close, countCloses, events, send } = journal();
    send("review", FIRST);
    append("review.brief", "delivery-kit", { messageId: "review" });
    close("review", FIRST);
    append("msg.imported", "system", {
      body: "Legacy COMPLETE reference",
      from: SENDER,
      id: "complete",
      legacy: { verified: true },
      to: FIRST,
    });
    close("complete", FIRST);
    send("queued-notice", FIRST);
    append("wake.claimed", "system", {
      conversation: "thread",
      harness: "codex",
      messages: ["queued-notice"],
      role: FIRST,
      wake: "notice",
    });
    append("wake.completed", "system", { outcome: "accepted", role: FIRST, wake: "notice" });
    close("queued-notice", FIRST);
    countCloses(100, FIRST);
    const plan = () =>
      planFileCompaction(events, {
        ...SCOPE,
        verifiedEvidence: proof(events, ["review", "complete", "queued-notice"]),
      }).streams.find((stream) => stream.source === FIRST)!;
    expect(plan().eligible.count).toBe(0);
    expect(plan().protected).toMatchObject([
      { count: 1, reason: "delivery-unresolved" },
      { count: 2, reason: "operational-body-reference" },
      { count: 100, reason: "within-window" },
    ]);
    append("notice.consumed", "system", { conversation: "other", id: "notice", role: FIRST });
    expect(plan().eligible.count).toBe(0);
    append("notice.consumed", "system", { conversation: "thread", id: "notice", role: FIRST });
    expect(plan().eligible.count).toBe(1);
  });
});
