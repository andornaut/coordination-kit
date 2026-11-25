import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { gameLayout } from "../../core/layout.ts";
import { clockAt, TEST_CLOCK, TEST_HOST } from "../../core/testFixtures.ts";
import { Store, storePath } from "../db.ts";
import { canonicalJson } from "../eventCodec.ts";
import { sendMessage } from "../messages.ts";
import { answerQuestion, openQuestion, recordQuestionAnswer, setHold } from "../questions.ts";
import { COORDINATOR, GAME, storeFixture, TECH } from "../testStore.ts";
import { recordEvidence, retainWorkItem, startWork } from "../work.ts";
import {
  assertSqliteEquivalent,
  exportSqliteSnapshot,
  inspectSqliteConnection,
  inspectSqliteState,
  inventorySqliteSource,
  readSqliteSnapshot,
  restoreSqliteSnapshot,
} from "./snapshot.ts";

const AT = "2026-11-22T00:00:00.000Z";
const OWNER = { nativeId: COORDINATOR, role: "game-coordinator" };
const RECIPIENT = { nativeId: TECH, role: `${GAME}/tech` };
const ID = "00000000-0000-4000-8000-000000000001";
const SHA = "1".repeat(40);
const WORK = { id: "gc-0001", repository: "game-coordinator" };

function populate(store: Store): void {
  sendMessage(store, OWNER, {
    body: "Fixture message",
    id: ID,
    intent: "queue",
    to: RECIPIENT.role,
  });
  store.append({
    actor: OWNER,
    key: "wake.claimed:fixture",
    kind: "wake.claimed",
    payload: {
      conversation: TECH,
      count: 1,
      harness: "claude",
      role: RECIPIENT.role,
      wake: "wake-fixture",
    },
  });
  openQuestion(store, OWNER, { id: "pending-fixture", title: "Pending fixture", work: WORK.id });
  openQuestion(store, OWNER, { id: "answered-fixture", title: "Answered fixture", work: WORK.id });
  recordQuestionAnswer(TEST_HOST, store, OWNER, "answered-fixture", {
    text: "Example decision",
    work: WORK.id,
  });
  answerQuestion(TEST_HOST, store, OWNER, "answered-fixture", {
    text: "Example decision",
    work: WORK.id,
  });
  startWork(store, OWNER, { owner: OWNER.role, parent: null, ref: WORK });
  recordEvidence(store, OWNER, { ref: WORK, sha: SHA, stage: "implemented" });
  setHold(store, OWNER, {
    id: "hold-fixture",
    reason: "Approval pending",
    scope: `work:${WORK.id}`,
  });
  retainWorkItem(store, OWNER, {
    entry: "unknown-worker",
    nextBoundary: "Hourly review",
    owner: RECIPIENT.role,
    reason: "Worker evidence is unknown",
    ref: WORK,
    source: "approval-ledger",
  });
  store.append({
    actor: OWNER,
    key: "handoff.opened:fixture",
    kind: "handoff.opened",
    payload: {
      from: "claude",
      id: "ho-fixture",
      roles: [{ from: "claude", role: RECIPIENT.role }],
      to: "codex",
    },
  });
  store.append({
    actor: OWNER,
    key: "review.brief:fixture",
    kind: "review.brief",
    payload: { game: GAME, messageId: ID, recipient: OWNER.role, slot: 1 },
  });
  store.append({
    actor: OWNER,
    key: "review.unknown:fixture",
    kind: "review.unknown",
    payload: { reason: "Unknown visibility", role: RECIPIENT.role },
  });
}

describe("SQLite migration snapshots", () => {
  it("copies committed WAL state, restores independently and matches runtime replay", () => {
    const { base, layout } = storeFixture();
    const source = storePath(layout);
    const backup = join(base, "backup.db");
    const restored = join(base, "restored.db");
    const store = Store.open(clockAt(AT), source);
    try {
      populate(store);
      const expected = inspectSqliteState(source);
      for (const name of [
        "messages",
        "wake_state",
        "wakes",
        "questions",
        "decisions",
        "holds",
        "handoff_roles",
        "review_briefs",
        "question_answers",
        "work_evidence",
        "work_retained",
      ]) {
        expect(expected.projections[name]?.rows, name).toBeGreaterThan(0);
      }
      expect(expected.missingProjections).toEqual([]);
      store.transaction(() => {
        store.append({
          actor: OWNER,
          key: "work.uncommitted:fixture",
          kind: "work.uncommitted",
          payload: {},
        });
        const exported = exportSqliteSnapshot(source, backup);
        assertSqliteEquivalent(expected, exported);
      });
      expect(inspectSqliteState(source).head.seq).toBe(expected.head.seq + 1);
      assertSqliteEquivalent(expected, restoreSqliteSnapshot(backup, restored));
      expect(statSync(backup).ino).not.toBe(statSync(restored).ino);
      expect(statSync(source).ino).not.toBe(statSync(backup).ino);
      expect(statSync(backup).mode & 0o777).toBe(0o600);
      expect(existsSync(`${backup}-wal`)).toBe(false);
      expect(existsSync(`${restored}-wal`)).toBe(false);
      expect(() => restoreSqliteSnapshot(backup, source)).toThrow("snapshot-destination-exists");
      expect(() => restoreSqliteSnapshot(backup, restored)).toThrow("snapshot-destination-exists");

      const transferred = readSqliteSnapshot(backup);
      expect(transferred.events.map(({ seq }) => seq)).toEqual(
        Array.from({ length: expected.events }, (_, index) => index + 1),
      );
      expect(transferred.events.at(-1)?.kind).toBe("review.unknown");
      const runtime = Store.open(clockAt(AT), ":memory:");
      try {
        for (const event of transferred.events) {
          expect(runtime.append(event).event).toEqual(event);
        }
        assertSqliteEquivalent(transferred.state, inspectSqliteConnection(runtime.db));
      } finally {
        runtime.close();
      }
    } finally {
      store.close();
    }
  });

  it("refuses durable projection drift even with a valid event chain", () => {
    const { base, layout } = storeFixture();
    const source = storePath(layout);
    const backup = join(base, "backup.db");
    const store = Store.open(clockAt(AT), source);
    try {
      populate(store);
      const expected = inspectSqliteConnection(store.db);
      store.db.exec(
        "UPDATE wake_state SET outstanding = NULL; UPDATE holds SET reason = 'projection changed'",
      );
      const actual = inspectSqliteConnection(store.db);
      expect(actual.head).toEqual(expected.head);
      expect(() => assertSqliteEquivalent(expected, actual)).toThrow(
        "snapshot-projection-mismatch: holds, wake_state",
      );
      expect(() => exportSqliteSnapshot(source, backup)).toThrow(
        "snapshot-projection-mismatch: holds, wake_state",
      );
      expect(existsSync(backup)).toBe(false);
      expect(inspectSqliteConnection(store.db)).toEqual(actual);
    } finally {
      store.close();
    }
  });

  it("bounds an exclusive competing writer and leaves no destination", () => {
    const { base, layout } = storeFixture();
    const source = storePath(layout);
    const backup = join(base, "backup.db");
    Store.open(TEST_CLOCK, source).close();
    const writer = new DatabaseSync(source);
    try {
      writer.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
      expect(() => exportSqliteSnapshot(source, backup)).toThrow("snapshot-source-busy");
      expect(existsSync(backup)).toBe(false);
    } finally {
      writer.close();
    }
  });

  it("identifies missing legacy projections and derived graph tables and refuses unknown durable tables", () => {
    const { base, layout } = storeFixture();
    const source = storePath(layout);
    const backup = join(base, "backup.db");
    const store = Store.open(clockAt(AT), source);
    try {
      store.db.exec("DROP TABLE question_answers; CREATE TABLE edges (key TEXT)");
      expect(inspectSqliteConnection(store.db)).toMatchObject({
        derivedTables: ["edges"],
        missingProjections: ["question_answers"],
      });
      expect(() => exportSqliteSnapshot(source, backup)).toThrow(
        "snapshot-projection-missing: question_answers",
      );
      expect(existsSync(backup)).toBe(false);
      store.db.exec("CREATE TABLE unknown_fixture (key TEXT)");
      expect(() => inspectSqliteState(source)).toThrow("snapshot-unknown-tables");
    } finally {
      store.close();
    }
  });

  it("fails closed on an edited event and leaves the destination absent", () => {
    const { base, layout } = storeFixture();
    const source = storePath(layout);
    const backup = join(base, "backup.db");
    const store = Store.open(clockAt(AT), source);
    populate(store);
    store.close();
    const raw = new DatabaseSync(source);
    try {
      raw.exec("DROP TRIGGER events_no_update; UPDATE events SET payload = '{}' WHERE seq = 1");
    } finally {
      raw.close();
    }
    expect(() => exportSqliteSnapshot(source, backup)).toThrow(
      "snapshot-chain-broken: after seq 0",
    );
    expect(existsSync(backup)).toBe(false);
  });

  it("inventories validated structures and per-game cursor paths without exposing their values", () => {
    const { layout } = storeFixture();
    const { busDir } = gameLayout(layout, GAME);
    mkdirSync(busDir, { recursive: true });
    const cursor = {
      at: AT,
      dev: null,
      file: "events.jsonl",
      firstId: "a".repeat(64),
      inode: null,
      lastId: null,
      lines: 1,
      offset: 31,
      schema: 1,
    };
    writeFileSync(join(busDir, "events.cursor"), canonicalJson(cursor));
    const first = inventorySqliteSource(layout);
    const cursorPath = `var/games/${GAME}/bus/events.cursor`;
    expect(first.entries).toContainEqual(
      expect.objectContaining({
        path: cursorPath,
        scope: "coordinator",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        status: "file",
      }),
    );
    expect(first.entries).toContainEqual(
      expect.objectContaining({
        path: "var/registry.json",
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(first.registryRevision).toBeGreaterThan(0);
    expect(JSON.stringify(first)).not.toContain(TECH);
    expect(JSON.stringify(first)).not.toContain(cursor.firstId);
    expect(JSON.stringify(first)).not.toContain(layout.root);
    writeFileSync(join(busDir, "events.cursor"), "malformed");
    expect(inventorySqliteSource(layout).entries).toContainEqual({
      path: cursorPath,
      scope: "coordinator",
      status: "unavailable",
    });
    writeFileSync(join(layout.varDir, "work-protocol.json"), "malformed");
    expect(inventorySqliteSource(layout).entries).toContainEqual({
      path: "coordination.db",
      scope: "sqlite-state",
      status: "unavailable",
    });
  });
});
