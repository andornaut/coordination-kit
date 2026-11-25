import { describe, expect, it } from "vitest";

import { MEMORY, Store } from "../db.ts";
import { canonicalJson, sha256 } from "../eventCodec.ts";
import type { FileProjection } from "../fileProjection.ts";
import { recordSession } from "../handoffs.ts";
import {
  closeMessage,
  exportSince,
  messageHistory,
  messageStatus,
  messageWithBody,
  recipientMessages,
  sendMessage,
} from "../messages.ts";
import type { StoredEvent } from "../types.ts";
import { prepareCompactionCheckpoint, verifyCompactionSource } from "./compactionCheckpoint.ts";

const SENDER = { nativeId: "test-sender", role: "sample-kit" };
const RECIPIENT = { nativeId: "test-recipient", role: "sample-game/tech" };
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
  closeMessage(store, RECIPIENT, LEGACY);
  for (let index = 0; index < 100; index += 1) {
    const id = `recent-${index}`;
    session(id);
    tick(`slot-${index}`);
    importMessage(id, `Body ${index}`);
    closeMessage(store, RECIPIENT, id);
  }
  importMessage(LEGACY_EMPTY, "");
  closeMessage(store, RECIPIENT, LEGACY_EMPTY);
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
    runner: store.db.prepare("SELECT * FROM bus_events ORDER BY seq").all(),
    sessions: store.db.prepare("SELECT * FROM sessions ORDER BY role").all(),
    wakes: store.db.prepare("SELECT * FROM wake_state ORDER BY role").all(),
  };
}

describe("qualified compacted store replay", () => {
  it("preserves projections, explicit expiry, exact deduplication and ordinary appends", () => {
    const source = Store.open(MEMORY, { now: () => CLOCK });
    try {
      const { legacy, oldSession, oldTick, proof } = fixture(source);
      const tail: StoredEvent[] = [];
      const projection = { ...journal(tail), checkpoint: proof };
      const store = Store.openFileProjection(MEMORY, projection, { now: () => CLOCK });
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
        const reopened = Store.openFileProjection(MEMORY, projection, { now: () => CLOCK });
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

  it("requires a qualified receipt and rejects modified reduced events during verify and rebuild", () => {
    const source = Store.open(MEMORY, { now: () => CLOCK });
    try {
      const { checkpoint, oldSession, proof } = fixture(source);
      const prefix = checkpoint.entries.map(({ event }) => event);
      expect(() => Store.openFileProjection(MEMORY, journal(prefix))).toThrow("chain-broken");
      expect(() =>
        Store.openFileProjection(MEMORY, {
          ...journal([]),
          checkpoint: { ...proof, receipt: { ...proof.receipt, digest: "unqualified" } },
        }),
      ).toThrow("checkpoint-digest-mismatch");
      const tail: StoredEvent[] = [];
      const store = Store.openFileProjection(MEMORY, { ...journal(tail), checkpoint: proof });
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
        store.db.exec("DROP TRIGGER events_no_update");
        store.db
          .prepare(
            "UPDATE events SET payload = json_set(payload, '$.version', 'altered') WHERE seq = ?",
          )
          .run(oldSession.seq);
        expect(() => store.verify()).toThrow("chain-broken");
        expect(() => store.rebuild()).toThrow("chain-broken");
      } finally {
        store.close();
      }
    } finally {
      source.close();
    }
  });
});
