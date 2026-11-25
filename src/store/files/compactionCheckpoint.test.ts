import { describe, expect, it } from "vitest";

import { canonicalJson, eventHash, sha256 } from "../eventCodec.ts";
import { type EventInput, GENESIS, type StoredEvent } from "../types.ts";
import {
  prepareCompactionCheckpoint,
  verifyCompactionCheckpoint,
  verifyCompactionSource,
  verifyCompactionTail,
} from "./compactionCheckpoint.ts";
import type { CompactionScope } from "./compactionPlan.ts";

const SENDER = { nativeId: "00000000-0000-4000-8000-000000000001", role: "sample-kit" };
const RECIPIENT = { nativeId: "00000000-0000-4000-8000-000000000002", role: "sample-game/tech" };
const CLOCK = "2026-11-21T00:00:00.000Z";
const CONTENT = "Historical note with a verified replacement";
const SCOPE = {
  registeredGames: new Set(["sample-game"]),
  registeredRoles: new Set([SENDER.role, RECIPIENT.role]),
  registryRevision: 7,
};

function next({ hash, seq }: Pick<StoredEvent, "hash" | "seq">, input: EventInput): StoredEvent {
  const draft = { ...input, at: input.at ?? CLOCK, prevHash: hash, seq: seq + 1 };
  return { ...draft, hash: eventHash(draft) };
}

function journal() {
  const events: StoredEvent[] = [];
  const append = (input: EventInput) => {
    const event = next(events.at(-1) ?? { hash: GENESIS, seq: 0 }, input);
    events.push(event);
    return event;
  };
  return { append, events };
}

function message(id: string, body = CONTENT): EventInput {
  return {
    actor: SENDER,
    key: `msg.sent:${id}`,
    kind: "msg.sent",
    payload: {
      body,
      bodySha256: sha256(body),
      createdAt: CLOCK,
      from: SENDER.role,
      id,
      intent: "queue",
      links: [{ kind: "work", ref: "sk-0001" }],
      to: RECIPIENT.role,
      worker: null,
    },
  };
}

function session(id: string): EventInput {
  return {
    actor: RECIPIENT,
    key: `session.started:${id}`,
    kind: "session.started",
    payload: {
      cwd: "/synthetic/project",
      harness: "codex",
      nativeId: RECIPIENT.nativeId,
      role: RECIPIENT.role,
      version: "3.4.0",
    },
  };
}

function messages(first: EventInput = message("expired"), closeFirst = true) {
  const { append, events } = journal();
  const original = append(first);
  const close = (id: string) =>
    append({
      actor: RECIPIENT,
      key: `msg.closed:${id}`,
      kind: "msg.closed",
      payload: { id, state: "handled" },
    });
  const anchor = closeFirst ? close("expired") : append(session("anchor"));
  for (let offset = 0; offset < 100; offset += 1) {
    const id = `recent-${offset}`;
    append(message(id, `${id} kept`));
    close(id);
  }
  return { anchor, append, events, original };
}

function scope(
  events: readonly StoredEvent[],
  messageIds: readonly string[] = [],
  routineEventSequences: readonly number[] = [],
): CompactionScope {
  const { hash, seq } = events.at(-1)!;
  return {
    ...SCOPE,
    verifiedEvidence: {
      head: { hash, seq },
      messageIds: new Set(messageIds),
      registryRevision: SCOPE.registryRevision,
      routineEventSequences: new Set(routineEventSequences),
    },
  };
}

describe("filesystem compaction checkpoint", () => {
  it("seals reduced contents and preserves all other events and deduplication inputs exactly", () => {
    const { anchor, events, original } = messages();
    const evidence = scope(events, ["expired"]);
    const { checkpoint, receipt } = prepareCompactionCheckpoint(events, evidence, anchor);
    const { body: removed, ...identity } = original.payload;
    const reduced = checkpoint.entries[0]!;
    expect(reduced.reducedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(reduced.event).toEqual({ ...original, payload: identity });
    expect(canonicalJson(checkpoint)).not.toContain(removed);
    expect(checkpoint.anchor).toEqual({ hash: anchor.hash, seq: anchor.seq });
    expect(checkpoint.entries.slice(1)).toEqual(events.slice(1).map((event) => ({ event })));

    const reloaded = JSON.parse(canonicalJson(checkpoint)) as unknown;
    expect(verifyCompactionSource(reloaded, receipt, events, evidence, anchor)).toEqual(checkpoint);
    expect(verifyCompactionCheckpoint(reloaded, receipt)).toEqual(checkpoint);
    const tail = next(checkpoint.head, session("tail"));
    expect(verifyCompactionTail(checkpoint, [tail])).toEqual({ hash: tail.hash, seq: tail.seq });
    expect(() =>
      verifyCompactionTail(checkpoint, [next(checkpoint.head, message("expired"))]),
    ).toThrow("checkpoint-source-chain");
    expect(() =>
      verifyCompactionTail(checkpoint, [
        next({ hash: checkpoint.head.hash, seq: checkpoint.head.seq + 1 }, session("skip")),
      ]),
    ).toThrow("checkpoint-source-chain");
  });

  it("reduces only the approved routine payload fields", () => {
    const { append, events } = journal();
    const anchor = append(session("anchor"));
    const old = append(session("old"));
    const tick: EventInput = {
      actor: { nativeId: null, role: "delivery-kit" },
      key: "bus.event:old-tick",
      kind: "bus.event",
      payload: {
        at: CLOCK,
        detail: "historical tick prose",
        game: "sample-game",
        id: "old-tick",
        key: "2026-11-21T00:00:00Z",
        kind: "runner",
        schema: 1,
        sha: null,
        status: null,
        type: "scheduled-status",
        work: null,
      },
    };
    const oldTick = append(tick);
    for (let index = 0; index < 100; index += 1) {
      append(session(`kept-${index}`));
      append({
        ...tick,
        key: `bus.event:kept-${index}`,
        payload: { ...tick.payload, detail: null, id: `kept-${index}`, key: `slot-${index}` },
      });
    }
    const { checkpoint } = prepareCompactionCheckpoint(
      events,
      scope(events, [], [old.seq, oldTick.seq]),
      anchor,
    );
    expect(checkpoint.entries[1]?.event.payload).not.toHaveProperty("cwd");
    const { detail, ...kept } = oldTick.payload;
    expect(checkpoint.entries[2]?.event).toEqual({ ...oldTick, payload: kept });
    expect(canonicalJson(checkpoint.entries[2])).not.toContain(detail);
    expect(checkpoint.entries[0]).toEqual({ event: anchor });
    expect(checkpoint.entries.at(-1)).toEqual({ event: events.at(-1) });
  });

  it("rejects unqualified, missing, overlapping and protected selectors", () => {
    const { anchor, append, events, original } = messages();
    expect(() => prepareCompactionCheckpoint(events, scope(events, ["expired"]))).toThrow(
      "checkpoint-anchor-protected",
    );
    expect(() => prepareCompactionCheckpoint(events, scope(events, ["expired"]), original)).toThrow(
      "checkpoint-anchor-protected",
    );
    expect(() =>
      prepareCompactionCheckpoint(events, scope(events, ["expired"]), { ...anchor, hash: GENESIS }),
    ).toThrow("checkpoint-anchor-mismatch");
    for (const invalid of [
      scope(events, ["missing"]),
      scope(events, ["recent-0"]),
      scope(events, ["expired"], [original.seq]),
    ]) {
      expect(() => prepareCompactionCheckpoint(events, invalid, anchor)).toThrow(
        "checkpoint-selection-unqualified",
      );
    }

    const dependent = message("open-dependent");
    append({
      ...dependent,
      payload: { ...dependent.payload, links: [{ kind: "message", ref: "expired" }] },
    });
    expect(() => prepareCompactionCheckpoint(events, scope(events, ["expired"]), anchor)).toThrow(
      "checkpoint-selection-unqualified",
    );

    const open = messages(message("expired"), false);
    expect(() =>
      prepareCompactionCheckpoint(open.events, scope(open.events, ["expired"]), open.anchor),
    ).toThrow("checkpoint-selection-unqualified");
  });

  it("refuses unexpected note fields, copied body text and mismatched message identity", () => {
    const first = message("expired");
    for (const invalid of [
      { ...first, payload: { ...first.payload, note: CONTENT } },
      { ...first, payload: { ...first.payload, worker: CONTENT } },
      { ...first, payload: { ...first.payload, bodySha256: sha256("different body") } },
      {
        ...first,
        payload: {
          ...first.payload,
          links: [
            { kind: "work", ref: "sk-0001" },
            { kind: "work", ref: "sk-0001" },
          ],
        },
      },
    ]) {
      const { anchor, events } = messages(invalid);
      expect(() => prepareCompactionCheckpoint(events, scope(events, ["expired"]), anchor)).toThrow(
        "checkpoint-payload-unqualified",
      );
    }
  });

  it("rejects candidate edits, reordering, truncation and changed or duplicate source identities", () => {
    const { anchor, append, events, original } = messages();
    const evidence = scope(events, ["expired"]);
    const { checkpoint, receipt } = prepareCompactionCheckpoint(events, evidence, anchor);
    const [first, second, ...rest] = checkpoint.entries;
    for (const entries of [
      [{ ...first!, reducedDigest: GENESIS }, second!, ...rest],
      [second!, first!, ...rest],
      [second!, ...rest],
    ]) {
      expect(() => verifyCompactionCheckpoint({ ...checkpoint, entries }, receipt)).toThrow(
        "checkpoint-digest-mismatch",
      );
    }
    expect(() =>
      verifyCompactionSource(checkpoint, { ...receipt, digest: GENESIS }, events, evidence, anchor),
    ).toThrow("checkpoint-proof-mismatch");
    expect(() => prepareCompactionCheckpoint(events.slice(1), evidence, anchor)).toThrow(
      "checkpoint-source-chain",
    );
    append(session("later"));
    expect(() => verifyCompactionSource(checkpoint, receipt, events, evidence, anchor)).toThrow(
      "checkpoint-evidence-mismatch",
    );
    append({ ...message("different"), key: original.key });
    expect(() => prepareCompactionCheckpoint(events, scope(events, ["expired"]), anchor)).toThrow(
      "checkpoint-source-chain",
    );
  });
});
