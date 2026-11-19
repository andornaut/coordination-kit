import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readWakeFile, wakeFilePath } from "../adapters/claude/wakeFile.ts";
import { messageExpectation, MessageStore } from "../messages/store.ts";
import type { MessageOwner, MessageRecord } from "../messages/types.ts";
import { Store, storePath } from "./db.ts";
import { importLegacy, type LegacySource } from "./legacy.ts";
import { messageStatus } from "./messages.ts";
import { storeImport } from "./service.ts";
import { COORDINATOR, storeFixture, TECH, TECH_CODEX } from "./testStore.ts";

const TECH_ROLE = "archies-dog-walks/tech";
const WORKER = "00000000-0000-4000-8000-0000000000e1";
const CLAUDE_OWNER: MessageOwner = { harness: "claude", nativeId: TECH, parentBinding: null };
const WORKER_OWNER: MessageOwner = {
  harness: "codex",
  nativeId: WORKER,
  parentBinding: { nativeId: TECH_CODEX, role: TECH_ROLE },
};
const RETENTION = {
  nextBoundary: "next scheduled review",
  ownerRole: TECH_ROLE,
  reason: "waiting on art",
};

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Legacy records written by the legacy store itself, one per state, under `<reviewDir>/messages`. */
async function legacyRecords(reviewDir: string) {
  const directory = join(reviewDir, "messages");
  let tick = 0;
  const legacy = new MessageStore({
    layout: { reviewDir },
    now: () => new Date(Date.UTC(2026, 10, 17, 9, 0, tick++)).toISOString(),
    resolveOwner: (_role, envelope) =>
      envelope.workerId === undefined ? CLAUDE_OWNER : WORKER_OWNER,
  });
  let n = 0;
  const ids: Record<string, string> = {};
  const enqueue = async (name: string, worker = false): Promise<MessageRecord> => {
    n++;
    ids[name] = uuid(0x200 + n);
    return legacy.enqueue({
      body: `Legacy body ${name}.\n`,
      created: `2026-11-16T10:00:${String(n).padStart(2, "0")}.000Z`,
      fromRole: "game-coordinator",
      id: ids[name],
      intent: "queue",
      schema: 1,
      toRole: TECH_ROLE,
      ...(worker ? { parentRole: TECH_ROLE, workerId: WORKER } : {}),
    });
  };
  const attempt = async (
    name: string,
    state: "accepted" | "ambiguous" | "blocked",
    worker = false,
  ) => {
    const record = await enqueue(name, worker);
    const lease = await legacy.beginAttempt(
      messageExpectation(record),
      worker ? "parent" : "recipient",
    );
    const done = lease.complete({
      reason: state === "accepted" ? null : state === "blocked" ? "guarded" : "lost-response",
      source: lease.source,
      state,
    });
    return { record: done, requestId: lease.source.requestId };
  };
  const spool = (requestId: string) => {
    const path = join(directory, "recipients", TECH, "unblock", "claude-spool");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, `${requestId}.json`), JSON.stringify({ kind: "message", requestId }));
  };
  const sending = async (name: string) => {
    const record = await enqueue(name);
    const lease = await legacy.beginAttempt(messageExpectation(record));
    const file = join(directory, `${hash(ids[name]!)}.json`);
    const bytes = readFileSync(file, "utf8");
    lease.close();
    writeFileSync(file, bytes);
    return lease.source.requestId;
  };
  await enqueue("queued");
  await legacy.block(messageExpectation(await enqueue("blocked")), "guarded");
  await legacy.hold(messageExpectation(await enqueue("held")), RETENTION);
  await attempt("accepted", "accepted");
  await attempt("ambiguous", "ambiguous");
  spool((await attempt("ambiguous-spooled", "ambiguous")).requestId);
  await sending("sending");
  spool(await sending("sending-spooled"));
  await attempt("parent-required", "accepted", true);
  for (const [name, kind] of [
    ["handled", "handled"],
    ["superseded", "superseded"],
    ["retained", "retained"],
  ] as const) {
    // Each record is written in turn, as the legacy store saw them.
    // eslint-disable-next-line no-await-in-loop
    const { record } = await attempt(name, "accepted");
    // eslint-disable-next-line no-await-in-loop
    await legacy.reconcile(messageExpectation(record), {
      kind,
      ref: `review-${name}`,
      retention: kind === "retained" ? RETENTION : null,
      source: messageExpectation(record).source,
    });
  }
  // A record whose stored body no longer matches its payload hash.
  const tampered = await enqueue("tampered");
  const file = join(directory, `${hash(tampered.envelope.id)}.json`);
  writeFileSync(file, readFileSync(file, "utf8").replace("Legacy body tampered", "Edited body"));
  return { directory, ids };
}

const EXPECTED: Record<string, [string, boolean]> = {
  accepted: ["delivered", false],
  ambiguous: ["delivered", true],
  "ambiguous-spooled": ["sent", false],
  blocked: ["sent", false],
  handled: ["handled", false],
  held: ["retained", false],
  "parent-required": ["delivered", false],
  queued: ["sent", false],
  retained: ["retained", false],
  sending: ["delivered", true],
  "sending-spooled": ["sent", false],
  superseded: ["superseded", false],
};

describe("legacy import", () => {
  it("maps every legacy state, dry-runs without writing and re-imports as a no-op", async () => {
    const { layout } = storeFixture();
    const { ids } = await legacyRecords(layout.reviewDir);
    const env = { CLAUDE_CODE_SESSION_ID: COORDINATOR };

    const dry = await storeImport({ env: {}, layout }, {}, { dryRun: true });
    expect(existsSync(storePath(layout))).toBe(false);
    expect(dry.imported).toBe(0);
    expect(dry.wakes).toEqual([]);
    expect(dry.counts).toEqual({
      actions: { changed: 0, duplicate: 0, insert: 12, invalid: 1, unchanged: 0 },
      legacy: {
        accepted: 1,
        ambiguous: 2,
        blocked: 1,
        handled: 1,
        held: 1,
        "parent-required": 1,
        queued: 1,
        retained: 1,
        sending: 2,
        superseded: 1,
      },
      mapped: {
        delivered: 2,
        "delivered-unconfirmed": 2,
        handled: 1,
        retained: 2,
        sent: 4,
        superseded: 1,
      },
    });
    expect(dry.diff.find((entry) => entry.action === "invalid")).toMatchObject({
      id: null,
      reason: "binding",
    });
    for (const [name, [state, unconfirmed]] of Object.entries(EXPECTED)) {
      expect(
        dry.diff.find((entry) => entry.id === ids[name]),
        name,
      ).toMatchObject({
        action: "insert",
        legacyState: name.replace("-spooled", ""),
        state,
        unconfirmed,
      });
    }
    await expect(storeImport({ env: {}, layout }, {}, { dryRun: false })).rejects.toThrow(
      "caller-unidentified",
    );

    const real = await storeImport({ env, layout }, {}, { dryRun: false });
    expect(real.imported).toBe(12);
    // One guarded wake for the recipient, counting only `sent` messages, never the unconfirmed.
    expect(real.wakes).toEqual([{ role: TECH_ROLE, status: "accepted" }]);
    expect(readWakeFile(wakeFilePath(layout, TECH))).toEqual({ count: 4, role: TECH_ROLE, seq: 1 });

    const store = Store.forLayout(layout);
    for (const [name, [state, unconfirmed]] of Object.entries(EXPECTED)) {
      const message = messageStatus(store, ids[name]!, true);
      expect(message, name).toMatchObject({ state, unconfirmed });
      expect(message.body).toBe(`Legacy body ${name}.\n`);
      expect(message.bodySha256).toBe(hash(`Legacy body ${name}.\n`));
      expect(message.legacy).toMatchObject({
        payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        source: "pre-activation",
      });
    }
    expect(messageStatus(store, ids.handled!).evidence).toEqual(["handled:review-handled"]);
    expect(messageStatus(store, ids.held!).retention).toMatchObject({
      nextBoundary: RETENTION.nextBoundary,
      owner: TECH_ROLE,
    });
    expect(messageStatus(store, ids.retained!).retention).toMatchObject({
      reason: "waiting on art",
    });
    expect(messageStatus(store, ids["parent-required"]!).links).toEqual([
      { kind: "worker-target", ref: WORKER },
    ]);
    expect(messageStatus(store, ids.accepted!).deliveredAt).toMatch(/^2026-11-17T09:00/);
    const events = store.events().length;
    store.close();

    const again = await storeImport({ env, layout }, {}, { dryRun: false });
    expect(again.imported).toBe(0);
    expect(again.counts.actions).toEqual({
      changed: 0,
      duplicate: 0,
      insert: 0,
      invalid: 1,
      unchanged: 12,
    });
    expect(again.wakes).toEqual([{ role: TECH_ROLE, status: "coalesced" }]);
    const reopened = Store.forLayout(layout);
    expect(reopened.events()).toHaveLength(events);
    reopened.verify();
    reopened.close();
  });

  it("imports each ID once across sources and reports a changed legacy record without overwriting", async () => {
    const { layout } = storeFixture();
    const { directory, ids } = await legacyRecords(layout.reviewDir);
    const copy = join(mkdtempSync(join(tmpdir(), "legacy-copy-")), "messages");
    cpSync(directory, copy, { recursive: true });
    const sources: LegacySource[] = [
      { label: "transport", path: copy },
      { label: "pre-activation", path: directory },
    ];
    const store = Store.open(":memory:");
    const actor = { nativeId: null, role: null };
    const first = importLegacy(store, actor, sources, { dryRun: false });
    expect(first.counts.actions).toMatchObject({ duplicate: 12, insert: 12, invalid: 2 });
    expect(messageStatus(store, ids.queued!).legacy?.source).toBe("transport");
    const file = join(copy, `${hash(ids.queued!)}.json`);
    const record = JSON.parse(readFileSync(file, "utf8")) as MessageRecord;
    const second = importLegacy(store, actor, sources.slice(0, 1), { dryRun: true });
    expect(second.counts.actions).toMatchObject({ changed: 0, insert: 0, unchanged: 12 });
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        evidence: [{ kind: "handled", ref: "late", retention: null, source: null }],
        state: "handled",
      }),
    );
    const third = importLegacy(store, actor, sources.slice(0, 1), { dryRun: false });
    expect(third.diff.find((entry) => entry.id === ids.queued)).toMatchObject({
      action: "changed",
      state: "handled",
    });
    expect(messageStatus(store, ids.queued!).state).toBe("sent");
    store.close();
  });
});
