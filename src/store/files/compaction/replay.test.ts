import { describe, expect, it } from "vitest";

import { clockAt, TEST_CLOCK } from "../../../core/testFixtures.ts";
import { MEMORY, Store } from "../../db.ts";
import { canonicalJson, sha256 } from "../../eventCodec.ts";
import type { FileProjection } from "../../fileProjection.ts";
import {
  closeMessage,
  decideMessage,
  exportSince,
  messageHistory,
  messageStatus,
  messageWithBody,
  readInbox,
  recipientMessages,
  sendMessage,
} from "../../messages/messages.ts";
import { recordSession } from "../../sessions/handoffs.ts";
import { type Actor, type StoredEvent, UNBOUND_MESSAGE_SENDER } from "../../types.ts";
import { prepareCompactionCheckpoint, verifyCompactionSource } from "./checkpoint.ts";

const SENDER = { nativeId: "00000000-0000-4000-8000-00000000000a", role: "sample-kit" };
const RECIPIENT = { nativeId: "00000000-0000-4000-8000-00000000000b", role: "sample-game/tech" };
const RUNNER = { nativeId: null, role: "delivery-kit" };
const CLOCK = "2026-11-21T00:00:00.000Z";
const SINCE = "2026-11-20T00:00:00.000Z";
const ORIGINAL = {
  body: "Old handled body with a qualified replacement.",
  id: "00000000-0000-4000-8000-000000000010",
  intent: "queue" as const,
  links: [
    { kind: "work", ref: "sk-0001" },
    { kind: "request", ref: "request-1" },
  ],
  to: RECIPIENT.role,
};
const LEGACY = "legacy-old";
const LEGACY_EMPTY = "legacy-empty";
const OPEN = "00000000-0000-4000-8000-000000000020";
const DISPOSITION = { evidence: ["work/sk-0001#replacement"], work: "sk-0001" };

function fixture(store: Store) {
  const session = (key: string) =>
    recordSession(store, RECIPIENT, {
      cwd: `/synthetic/${key}`,
      harness: "codex",
      key,
      version: "3.4.4",
    });
  const importMessage = (id: string, body: string) =>
    store.append({
      actor: SENDER,
      key: `msg.imported:${id}`,
      kind: "msg.imported",
      payload: {
        body,
        bodySha256: sha256(body),
        createdAt: CLOCK,
        from: SENDER.role,
        id,
        intent: "queue",
        links: [],
        state: "sent",
        to: RECIPIENT.role,
      },
    }).event;
  const historicalClose = (id: string) =>
    store.append({
      actor: RECIPIENT,
      key: `msg.closed:${id}`,
      kind: "msg.closed",
      payload: { evidence: [], id, state: "handled", supersededBy: null, work: null },
    });
  const tick = (id: string) =>
    store.append({
      actor: RUNNER,
      key: `bus.event:${id}`,
      kind: "bus.event",
      payload: {
        at: CLOCK,
        detail: `Schedule ${id}`,
        game: "sample-game",
        id,
        key: id,
        kind: "runner",
        schema: 1,
        sha: null,
        status: null,
        type: "scheduled-status",
        work: null,
      },
    }).event;

  const anchor = session("anchor");
  const oldSession = session("old");
  const oldTick = tick("slot-old");
  sendMessage(store, SENDER, ORIGINAL);
  const legacy = importMessage(LEGACY, "Archived legacy text.");
  closeMessage(store, RECIPIENT, ORIGINAL.id, DISPOSITION);
  historicalClose(LEGACY);
  for (let index = 0; index < 100; index += 1) {
    const id = `recent-${index}`;
    session(id);
    tick(`slot-${index}`);
    importMessage(id, `Body ${index}`);
    historicalClose(id);
  }
  importMessage(LEGACY_EMPTY, "");
  historicalClose(LEGACY_EMPTY);
  sendMessage(store, SENDER, { ...ORIGINAL, body: "Current original", id: OPEN, links: [] });

  const events = store.events();
  const scope = {
    registeredGames: new Set(["sample-game"]),
    registeredRoles: new Set([SENDER.role, RECIPIENT.role]),
    registryRevision: 7,
    verifiedEvidence: {
      head: store.head(),
      messageIds: new Set([ORIGINAL.id, LEGACY]),
      registryRevision: 7,
      routineEventSequences: new Set([oldSession.seq, oldTick.seq]),
    },
  };
  const { checkpoint, receipt } = prepareCompactionCheckpoint(events, scope, anchor);
  const value: unknown = JSON.parse(canonicalJson(checkpoint));
  verifyCompactionSource(value, receipt, events, scope, anchor);
  return { checkpoint, legacy, oldSession, oldTick, proof: { receipt, value } };
}

function journal(tail: StoredEvent[]): FileProjection {
  const events = (afterSeq = 0) => tail.filter(({ seq }) => seq > afterSeq);
  return {
    journal: {
      events,
      withWriter: (body) =>
        body({
          commit: (batch) => {
            tail.push(...batch);
          },
          events,
        }),
    },
    records: () => [],
  };
}

function operationalState(store: Store) {
  return {
    closed: recipientMessages(store, RECIPIENT.role, ["handled", "superseded"]),
    open: recipientMessages(store, RECIPIENT.role, ["delivered", "retained", "sent"]),
    runner: store.index.rows("bus_events").toSorted((a, b) => Number(a.seq) - Number(b.seq)),
    sessions: store.index
      .rows("sessions")
      .toSorted((a, b) => String(a.role).localeCompare(String(b.role))),
    wakes: store.index
      .rows("wake_state")
      .toSorted((a, b) => String(a.role).localeCompare(String(b.role))),
  };
}

describe("qualified compacted store replay", () => {
  it("preserves projections, explicit expiry, exact deduplication and ordinary appends", () => {
    const source = Store.open(clockAt(CLOCK), MEMORY);
    try {
      const { legacy, oldSession, oldTick, proof } = fixture(source);
      const tail: StoredEvent[] = [];
      const projection = { ...journal(tail), checkpoint: proof };
      const store = Store.openFileProjection(clockAt(CLOCK), MEMORY, projection);
      try {
        expect(store.verify()).toEqual(source.verify());
        expect(operationalState(store)).toEqual(operationalState(source));
        expect(store.eventByKey(oldSession.key)?.payload).not.toHaveProperty("cwd");
        expect(store.eventByKey(oldTick.key)?.payload).not.toHaveProperty("detail");
        expect(store.eventByKey(legacy.key)?.payload).not.toHaveProperty("body");

        const unchanged = messageStatus(source, ORIGINAL.id);
        expect(messageStatus(store, ORIGINAL.id)).toEqual(unchanged);
        expect(messageStatus(store, ORIGINAL.id, true)).toEqual({
          ...unchanged,
          bodyExpired: true,
        });
        expect(messageWithBody(store, RECIPIENT.role, LEGACY)).toEqual({
          ...messageStatus(source, LEGACY),
          bodyExpired: true,
        });
        expect(() => messageWithBody(store, "other-kit", ORIGINAL.id)).toThrow(
          "message-not-visible",
        );
        expect(messageWithBody(store, SENDER.role, LEGACY_EMPTY)).toHaveProperty("body", "");
        expect(messageWithBody(store, SENDER.role, LEGACY_EMPTY)).not.toHaveProperty("bodyExpired");
        expect(messageWithBody(store, RECIPIENT.role, OPEN)).toEqual(
          messageWithBody(source, RECIPIENT.role, OPEN),
        );

        const historyEntry = (id: string, viewer: string) =>
          messageHistory(store, { viewer }).find(
            ({ detail, kind }) => kind.startsWith("msg.") && detail.id === id,
          )?.detail;
        expect(historyEntry(ORIGINAL.id, SENDER.role)).toHaveProperty("bodyExpired", true);
        expect(historyEntry(LEGACY, RECIPIENT.role)).toHaveProperty("bodyExpired", true);
        expect(historyEntry(ORIGINAL.id, "other-kit")).not.toHaveProperty("bodyExpired");
        expect(historyEntry(LEGACY_EMPTY, SENDER.role)).toHaveProperty("body", "");

        const before = exportSince(source, SINCE);
        const after = exportSince(store, SINCE);
        expect(after.closes).toEqual(before.closes);
        expect(after.messages).toEqual(before.messages.filter(({ id }) => id !== ORIGINAL.id));
        const { body: exportedBody, ...expired } = before.messages.find(
          ({ id }) => id === ORIGINAL.id,
        )!;
        expect(exportedBody).toBe(ORIGINAL.body);
        expect(after.expiredMessages).toEqual([{ ...expired, bodyExpired: true }]);

        expect(
          sendMessage(store, SENDER, { ...ORIGINAL, links: [...ORIGINAL.links].reverse() }),
        ).toEqual({ duplicate: true, message: unchanged });
        expect(closeMessage(store, RECIPIENT, ORIGINAL.id, DISPOSITION).duplicate).toBe(true);
        expect(() => sendMessage(store, SENDER, { ...ORIGINAL, body: "Different text" })).toThrow(
          "id-conflict",
        );
        expect(tail).toEqual([]);
        const key = `msg.sent:${ORIGINAL.id}`;
        const full = source.eventByKey(key)!;
        const { body, ...metadata } = full.payload;
        expect(body).toBe(ORIGINAL.body);
        expect(store.eventByKey(key)).toEqual({ ...full, payload: metadata });

        const sent = { ...ORIGINAL, id: "00000000-0000-4000-8000-000000000030" };
        sendMessage(store, SENDER, sent);
        sendMessage(source, SENDER, sent);
        expect(tail).toEqual(source.events({ afterSeq: proof.receipt.head.seq }));
        const reopened = Store.openFileProjection(clockAt(CLOCK), MEMORY, projection);
        try {
          expect(reopened.rebuild()).toEqual(source.verify());
          expect(operationalState(reopened)).toEqual(operationalState(source));
          expect(messageStatus(reopened, ORIGINAL.id, true)).toHaveProperty("bodyExpired", true);
          expect(messageStatus(reopened, LEGACY_EMPTY, true)).toHaveProperty("body", "");
        } finally {
          reopened.close();
        }
      } finally {
        store.close();
      }
    } finally {
      source.close();
    }
  });

  it("preserves unverified decisions through a checkpoint and atomically records an explicit decline", () => {
    const source = Store.open(clockAt(CLOCK), MEMORY);
    try {
      const { oldSession, oldTick } = fixture(source);
      const anchor = source.events()[0]!;
      closeMessage(source, RECIPIENT, OPEN);
      const unbound = { nativeId: null, role: UNBOUND_MESSAGE_SENDER };
      const runnerLookalike = { nativeId: "unverified", role: RUNNER.role };
      const append = (id: string, body: string, actor: Actor = unbound) =>
        sendMessage(source, actor, { body, id, intent: "queue", to: RECIPIENT.role });
      const declined = append("pending-decline", "Decline fixture.").message;
      const approved = append("pending-approve", "Approve fixture.", runnerLookalike).message;
      const generated = append("generated", "Runner fixture.", RUNNER).message;
      expect(approved).toMatchObject({ senderVerification: "unverified" });
      expect(generated).toMatchObject({ senderVerification: "verified" });
      expect(() => closeMessage(source, RECIPIENT, declined.id)).toThrow(
        "message-decision-required",
      );
      readInbox(source, RECIPIENT);
      closeMessage(source, RECIPIENT, generated.id);
      for (const original of [declined, approved]) {
        const input = {
          bodySha256: original.bodySha256,
          promptRef: `prompt:${original.id}`,
          status: "pending" as const,
        };
        expect(decideMessage(source, RECIPIENT, original.id, input).duplicate).toBe(false);
        expect(decideMessage(source, RECIPIENT, original.id, input).duplicate).toBe(true);
      }
      decideMessage(source, RECIPIENT, approved.id, {
        bodySha256: approved.bodySha256,
        scope: "Inspect the fixture",
        status: "approved",
        userReply: "reply:approved",
      });
      const scope = {
        registeredGames: new Set(["sample-game"]),
        registeredRoles: new Set([SENDER.role, RUNNER.role, RECIPIENT.role]),
        registryRevision: 7,
        verifiedEvidence: {
          head: source.head(),
          messageIds: new Set([ORIGINAL.id, LEGACY]),
          registryRevision: 7,
          routineEventSequences: new Set([oldSession.seq, oldTick.seq]),
        },
      };
      const { checkpoint, receipt } = prepareCompactionCheckpoint(source.events(), scope, anchor);
      const tail: StoredEvent[] = [];
      const projection = { ...journal(tail), checkpoint: { receipt, value: checkpoint } };
      const reopened = Store.openFileProjection(clockAt(CLOCK), MEMORY, projection);
      try {
        expect(readInbox(reopened, RECIPIENT).messages).toMatchObject([
          {
            decision: { display: "attested", id: declined.decision?.id, status: "pending" },
            id: declined.id,
          },
          { decision: { scope: "Inspect the fixture", status: "approved" }, id: approved.id },
        ]);
        const input = {
          bodySha256: declined.bodySha256,
          status: "declined" as const,
          userReply: "reply:declined",
        };
        expect(decideMessage(reopened, RECIPIENT, declined.id, input)).toMatchObject({
          duplicate: false,
          message: {
            decision: { status: "declined", userReply: "reply:declined" },
            state: "handled",
          },
        });
        expect(decideMessage(reopened, RECIPIENT, declined.id, input).duplicate).toBe(true);
        expect(() => closeMessage(reopened, RECIPIENT, declined.id)).toThrow("message-declined");
        expect(tail.map(({ kind }) => kind)).toEqual(["msg.decision", "msg.closed"]);
        expect(readInbox(reopened, RECIPIENT).messages.map(({ id }) => id)).toEqual([approved.id]);
        reopened.rebuild();
        expect(messageStatus(reopened, declined.id)).toMatchObject({
          decision: { id: declined.decision?.id, status: "declined" },
          senderVerification: "unverified",
        });
      } finally {
        reopened.close();
      }
    } finally {
      source.close();
    }
  });

  it("requires a qualified receipt and rejects modified reduced events during verify and rebuild", () => {
    const source = Store.open(clockAt(CLOCK), MEMORY);
    try {
      const { checkpoint, oldSession, proof } = fixture(source);
      const prefix = checkpoint.entries.map(({ event }) => event);
      expect(() => Store.openFileProjection(TEST_CLOCK, MEMORY, journal(prefix))).toThrow(
        "chain-broken",
      );
      expect(() =>
        Store.openFileProjection(TEST_CLOCK, MEMORY, {
          ...journal([]),
          checkpoint: { ...proof, receipt: { ...proof.receipt, digest: "unqualified" } },
        }),
      ).toThrow("checkpoint-digest-mismatch");
      const tail: StoredEvent[] = [];
      const store = Store.openFileProjection(TEST_CLOCK, MEMORY, {
        ...journal(tail),
        checkpoint: proof,
      });
      try {
        const unread = source.append({
          actor: RUNNER,
          key: "bus.event:next",
          kind: "bus.event",
          payload: { detail: "Normally hashed tail input" },
        }).event;
        tail.push({ ...unread, payload: {} });
        expect(() => store.rebuild()).toThrow("chain-broken");
        expect(store.head()).toEqual(proof.receipt.head);
        tail.pop();
        expect(Reflect.set(store.eventAt(oldSession.seq)!.payload, "version", "altered")).toBe(
          false,
        );
        expect(store.verify().head).toEqual(proof.receipt.head);
      } finally {
        store.close();
      }
    } finally {
      source.close();
    }
  });
});
