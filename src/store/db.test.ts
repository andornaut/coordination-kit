import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { clockAt, TEST_CLOCK, TEST_CONTEXT } from "../core/testFixtures.ts";
import { Store, storePath } from "./db.ts";
import { canonicalJson } from "./eventCodec.ts";
import { closeMessage, readInbox, retainMessage, sendMessage } from "./messages.ts";
import { storeFixture } from "./testStore.ts";
import { GENESIS } from "./types.ts";

const SENDER = { nativeId: "00000000-0000-4000-8000-00000000000a", role: "game-coordinator" };
const RECIPIENT = {
  nativeId: "00000000-0000-4000-8000-00000000000b",
  role: "archies-dog-walks/tech",
};

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), "store-db-")), "coordination.db");
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function messages(store: Store): unknown[] {
  return store.db.prepare("SELECT * FROM messages ORDER BY id").all();
}

function populate(store: Store): void {
  for (let n = 1; n <= 4; n++) {
    sendMessage(store, SENDER, {
      body: `body ${n}\n`,
      id: uuid(n),
      intent: "queue",
      to: RECIPIENT.role,
    });
  }
  readInbox(store, RECIPIENT);
  closeMessage(store, RECIPIENT, uuid(1), { evidence: ["commit:abc123"], work: "ck-0017" });
  closeMessage(store, RECIPIENT, uuid(2), { supersededBy: uuid(1) });
  retainMessage(store, RECIPIENT, uuid(3), {
    nextBoundary: "next review",
    owner: RECIPIENT.role,
    reason: "waiting on art",
  });
}

describe("canonicalJson", () => {
  it("sorts keys at every depth, drops undefined members and refuses non-finite numbers", () => {
    expect(canonicalJson({ b: [{ z: 1, a: null }], a: "x", c: undefined })).toBe(
      '{"a":"x","b":[{"a":null,"z":1}]}',
    );
    expect(() => canonicalJson({ n: Number.NaN })).toThrow("invalid-payload");
  });
});

describe("Store", () => {
  it("times each appended event with the store's clock and refuses one through a read-only store", () => {
    const { layout } = storeFixture();
    const writer = Store.forLayout(
      { ...TEST_CONTEXT, clock: clockAt("2026-01-02T03:04:05.000Z") },
      layout,
    );
    try {
      sendMessage(writer, SENDER, {
        body: "Timed.",
        id: uuid(1),
        intent: "queue",
        to: RECIPIENT.role,
      });
      expect(writer.events().map((event) => event.at)).toEqual(["2026-01-02T03:04:05.000Z"]);
    } finally {
      writer.close();
    }
    const reader = Store.readLayout(TEST_CONTEXT, layout)!;
    try {
      expect(() =>
        reader.append({ actor: SENDER, key: "read-only:1", kind: "test.read-only", payload: {} }),
      ).toThrow("store-read-only");
      expect(reader.events()).toHaveLength(1);
    } finally {
      reader.close();
    }
  });

  it("opens with WAL, synchronous FULL, a 5 s busy timeout, foreign keys and owner-only mode", () => {
    const store = Store.open(TEST_CLOCK, scratch());
    const pragma = (name: string) =>
      Object.values(store.db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("synchronous")).toBe(2);
    expect(pragma("busy_timeout")).toBe(5000);
    expect(pragma("foreign_keys")).toBe(1);
    expect(pragma("user_version")).toBe(1);
    store.close();
  });

  it("places the store under var/ without an active work protocol", () => {
    const { layout, root } = storeFixture();
    expect(storePath(layout)).toBe(join(root, "var", "coordination.db"));
  });

  it("chains every event to the previous hash from the genesis value", () => {
    const store = Store.open(TEST_CLOCK, scratch());
    populate(store);
    const events = store.events();
    expect(events[0]?.prevHash).toBe(GENESIS);
    for (let index = 1; index < events.length; index++) {
      expect(events[index]?.prevHash).toBe(events[index - 1]?.hash);
      expect(events[index]?.seq).toBe(index + 1);
    }
    expect(store.verify()).toEqual({ events: events.length, head: store.head() });
    store.close();
  });

  it("refuses updates and deletes of events", () => {
    const store = Store.open(TEST_CLOCK, scratch());
    populate(store);
    expect(() => store.db.exec("UPDATE events SET kind = 'x.y' WHERE seq = 1")).toThrow(
      "append-only",
    );
    expect(() => store.db.exec("DELETE FROM events WHERE seq = 1")).toThrow("append-only");
    store.close();
  });

  it("detects an edited payload and refuses to rebuild from a broken chain", () => {
    const path = scratch();
    const store = Store.open(TEST_CLOCK, path);
    populate(store);
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TRIGGER events_no_update");
    raw.exec(`UPDATE events SET payload = replace(payload, 'body 2', 'body X') WHERE seq = 2`);
    raw.close();
    const reopened = Store.open(TEST_CLOCK, path);
    expect(() => reopened.verify()).toThrow("chain-broken: at seq 2");
    expect(() => reopened.rebuild()).toThrow("chain-broken");
    reopened.close();
  });

  it("rebuilds every projection from the events to the same rows", () => {
    const store = Store.open(TEST_CLOCK, scratch());
    populate(store);
    const before = messages(store);
    const wakes = store.db.prepare("SELECT * FROM wake_state").all();
    store.db.exec("UPDATE messages SET state = 'handled', body = 'lost'");
    store.db.exec("DELETE FROM wake_state");
    const result = store.rebuild();
    expect(result.events).toBe(store.events().length);
    expect(messages(store)).toEqual(before);
    expect(store.db.prepare("SELECT * FROM wake_state").all()).toEqual(wakes);
    store.close();
  });

  it("rebuilds a journal holding retired reminder, notice and attention events", () => {
    const store = Store.open(TEST_CLOCK, scratch());
    // An older store also holds the retired projections' tables.
    store.db.exec(`CREATE TABLE pending_notices (id TEXT PRIMARY KEY);
      CREATE TABLE reminder_claims (id TEXT PRIMARY KEY);
      CREATE TABLE reminder_originals (claim_id TEXT, original_id TEXT)`);
    const system = { nativeId: null, role: null };
    const coordinator = { nativeId: null, role: "game-coordinator" };
    const codex = "00000000-0000-4000-8000-0000000000d3";
    sendMessage(store, SENDER, { body: "b\n", id: uuid(1), intent: "queue", to: RECIPIENT.role });
    const wake = (id: string) => {
      const claimed = store.append({
        actor: system,
        key: `wake.claimed:${id}`,
        kind: "wake.claimed",
        payload: {
          conversation: codex,
          count: 1,
          harness: "codex",
          messages: [uuid(1)],
          role: RECIPIENT.role,
          wake: id,
        },
      });
      store.append({
        actor: system,
        key: `wake.completed:${id}`,
        kind: "wake.completed",
        payload: {
          blocker: null,
          detail: null,
          outcome: "accepted",
          role: RECIPIENT.role,
          wake: id,
        },
      });
      return claimed.event.seq;
    };
    wake("w-1");
    store.append({
      actor: system,
      key: "notice.consumed:w-1",
      kind: "notice.consumed",
      payload: {
        conversation: codex,
        id: "w-1",
        item: "item-1",
        role: RECIPIENT.role,
        turn: "turn-1",
      },
    });
    store.append({
      actor: coordinator,
      key: "reminder.claimed:r-1",
      kind: "reminder.claimed",
      payload: {
        harness: "codex",
        id: "r-1",
        nativeId: codex,
        originals: [{ id: uuid(1), wake: "w-1" }],
        revision: 1,
        role: RECIPIENT.role,
      },
    });
    store.append({
      actor: coordinator,
      key: "reminder.settled:r-1",
      kind: "reminder.settled",
      payload: { id: "r-1", outcome: "submitted", reason: "typed" },
    });
    const claimSeq = wake("w-2");
    store.append({
      actor: system,
      key: "notice.released:w-2",
      kind: "notice.released",
      payload: {
        claimSeq,
        conversation: codex,
        id: "w-2",
        inboxReads: [],
        queueId: "queue-w-2",
        reason: "accepted-queue-absent-originals-collected",
        role: RECIPIENT.role,
      },
    });
    sendMessage(store, coordinator, {
      body: "Urgent work remains unread.",
      id: uuid(2),
      intent: "queue",
      links: [{ kind: "unblock-recipient", ref: RECIPIENT.role }],
      to: "game-coordinator",
    });
    closeMessage(store, coordinator, uuid(2), { evidence: ["attention-source-cleared"] });
    const before = messages(store);
    const wakes = store.db.prepare("SELECT * FROM wake_state ORDER BY role").all();
    expect(wakes).toContainEqual({ outstanding: null, pending: 1, role: RECIPIENT.role });
    expect(store.rebuild().events).toBe(store.events().length);
    expect(messages(store)).toEqual(before);
    expect(store.db.prepare("SELECT * FROM wake_state ORDER BY role").all()).toEqual(wakes);
    expect(
      store.db.prepare("SELECT state, delivered_at FROM messages WHERE id = ?").get(uuid(2)),
    ).toEqual({ delivered_at: null, state: "handled" });
    expect(
      store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('pending_notices', 'reminder_claims', 'reminder_originals')",
        )
        .all(),
    ).toEqual([]);
    store.close();
  });

  it("makes a repeated idempotency key a no-op that returns the stored event", () => {
    const store = Store.open(TEST_CLOCK, scratch());
    const actor = { nativeId: null, role: null };
    const first = store.append({ actor, key: "k-1", kind: "test.noted", payload: { n: 1 } });
    const again = store.append({ actor, key: "k-1", kind: "test.noted", payload: { n: 2 } });
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({ duplicate: true, event: first.event });
    expect(store.events()).toHaveLength(1);
    expect(() => store.append({ actor, key: "k-2", kind: "Bad", payload: {} })).toThrow(
      "invalid-event",
    );
    store.close();
  });

  it("rolls back a failed transaction without leaving an event", () => {
    const store = Store.open(TEST_CLOCK, scratch());
    expect(() =>
      store.transaction(() => {
        store.append({
          actor: { nativeId: null, role: null },
          key: "k",
          kind: "test.noted",
          payload: {},
        });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(store.head()).toEqual({ hash: GENESIS, seq: 0 });
    store.close();
  });

  it("refuses a store written by a newer schema", () => {
    const path = scratch();
    Store.open(TEST_CLOCK, path).close();
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version = 2");
    raw.close();
    expect(() => Store.open(TEST_CLOCK, path)).toThrow("store-schema-newer");
  });
});
