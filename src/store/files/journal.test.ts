import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { eventHash } from "../db.ts";
import { GENESIS, type StoredEvent } from "../types.ts";
import { type FileRecord, type JournalWriter, openFileJournal } from "./journal.ts";

const exec = promisify(execFile);
const journalModule = new URL("./journal.ts", import.meta.url).href;
const dbModule = new URL("../db.ts", import.meta.url).href;
const record: FileRecord = {
  data: { message: "Original" },
  path: "roles/archie%2Ftech/sent/1.json",
};

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), "coordination-journal-")), "root");
}

function event(key: string, previous?: StoredEvent): StoredEvent {
  const draft = {
    actor: { nativeId: null, role: "game-coordinator" },
    at: "2026-11-22T00:00:00.000Z",
    key,
    kind: "test.noted",
    payload: { key },
    prevHash: previous?.hash ?? GENESIS,
    seq: (previous?.seq ?? 0) + 1,
  };
  return { ...draft, hash: eventHash(draft) };
}

function args(script: string, root: string, mode: string, value: unknown = {}): string[] {
  return [
    "--input-type=module",
    "-e",
    script,
    journalModule,
    dbModule,
    root,
    mode,
    JSON.stringify(value),
  ];
}

const WRITE = `
  const [, journalModule, dbModule, root, mode, encoded] = process.argv;
  if (mode === "companion" || mode === "manifest") {
    const fs = (await import("node:fs")).default;
    const {syncBuiltinESMExports} = await import("node:module");
    const original = fs.linkSync;
    fs.linkSync = (from, to) => {
      original(from, to);
      if (mode === "manifest" ? to.includes("/journal/batches/") : to.includes("/roles/")) {
        process.exit(71);
      }
    };
    syncBuiltinESMExports();
  }
  const {openFileJournal} = await import(journalModule);
  const {eventHash} = await import(dbModule);
  const input = JSON.parse(encoded);
  openFileJournal(root).withWriter((writer) => {
    if (mode === "hold") {
      process.stdout.write("locked\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
      return;
    }
    if (mode === "pause") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
    const previous = writer.events().at(-1);
    const draft = {
      actor: { nativeId: null, role: "game-coordinator" },
      at: "2026-11-22T00:00:00.000Z",
      key: input.key,
      kind: "test.noted",
      payload: {key: input.key},
      prevHash: previous?.hash ?? "0".repeat(64),
      seq: (previous?.seq ?? 0) + 1,
    };
    writer.commit([{...draft, hash: eventHash(draft)}], input.records ?? []);
  });
`;

it("leaves a missing journal untouched and replays exact committed batches without overwriting", () => {
  const root = scratch();
  const journal = openFileJournal(root);
  expect(journal.events()).toEqual([]);
  expect(existsSync(root)).toBe(false);
  const first = event("first");
  const second = event("second", first);
  const third = event("third", second);

  journal.withWriter((writer) => {
    writer.commit([first, second], [record]);
    writer.commit([third], [{ data: true, path: "legacy/quarantine/3.json" }]);
  });
  journal.withWriter((writer) => writer.commit([first, second], [record]));
  expect(journal.events()).toEqual([first, second, third]);
  expect(journal.events(1)).toEqual([second, third]);
  expect(journal.events(3)).toEqual([]);
  expect(JSON.parse(readFileSync(join(root, record.path), "utf8"))).toEqual(record.data);
  expect(() =>
    journal.withWriter((writer) => writer.commit([first, second], [{ ...record, data: "edited" }])),
  ).toThrow("journal-replay-conflict");
  expect(() => journal.withWriter((writer) => writer.commit([event("first", third)]))).toThrow(
    "journal-key-conflict",
  );
  expect(() =>
    journal.withWriter((writer) => writer.commit([event("fourth", third)], [record])),
  ).toThrow("journal-record-conflict");
});

it("checks full evidence during replay and only the relevant boundary for an incremental read", () => {
  const root = scratch();
  const journal = openFileJournal(root);
  const first = event("first");
  const second = event("second", first);
  const third = event("third", second);
  journal.withWriter((writer) => {
    writer.commit([first], [record]);
    writer.commit([second]);
    writer.commit([third]);
  });
  writeFileSync(join(root, record.path), '"different"\n');
  expect(journal.events(2)).toEqual([third]);
  expect(() => journal.events()).toThrow("journal-record-mismatch");
  const fourth = event("fourth", third);
  journal.withWriter((writer) => writer.commit([fourth]));
  expect(journal.events(3)).toEqual([fourth]);
});

it("rejects paths outside the namespaces and symbolic links in a companion path", () => {
  const root = scratch();
  const journal = openFileJournal(root);
  const first = event("first");
  for (const path of [
    "../../target.json",
    "roles/../target.json",
    "journal/1.json",
    "/coordinator/target.json",
    "roles/game-coordinator",
  ]) {
    expect(() =>
      journal.withWriter((writer) => writer.commit([first], [{ data: true, path }])),
    ).toThrow("journal-invalid-record-path");
  }
  const other = mkdtempSync(join(tmpdir(), "coordination-other-"));
  mkdirSync(join(root, "roles"));
  symlinkSync(other, join(root, "roles", "linked"), "dir");
  expect(() =>
    journal.withWriter((writer) =>
      writer.commit([first], [{ data: true, path: "roles/linked/target.json" }]),
    ),
  ).toThrow("journal-path-conflict");
  expect(existsSync(join(other, "target.json"))).toBe(false);
  expect(journal.events()).toEqual([]);
});

it("refuses a writer retained past its lock boundary", () => {
  const journal = openFileJournal(scratch());
  const writer: JournalWriter = journal.withWriter((value) => value);
  expect(() => writer.events()).toThrow("journal-writer-closed");
  expect(() => writer.commit([event("first")])).toThrow("journal-writer-closed");
});

it.each(["companion", "manifest"])(
  "recovers an interruption after publishing a %s link",
  (mode) => {
    const root = scratch();
    const journal = openFileJournal(root);
    const first = event("first");
    const interrupted = spawnSync(
      process.execPath,
      args(WRITE, root, mode, { key: "first", records: [record] }),
      { encoding: "utf8" },
    );
    expect(interrupted.status, interrupted.stderr).toBe(71);
    expect(existsSync(join(root, record.path))).toBe(true);
    expect(journal.events()).toEqual(mode === "manifest" ? [first] : []);

    journal.withWriter((writer) => {
      expect(writer.events()).toEqual(mode === "manifest" ? [first] : []);
      expect(existsSync(join(root, record.path))).toBe(mode === "manifest");
      writer.commit([first], [record]);
    });
    expect(journal.events()).toEqual([first]);
    expect(existsSync(join(root, "journal", ".prepare.json"))).toBe(false);
    expect(existsSync(join(root, "journal", ".record.tmp"))).toBe(false);
  },
);

it("keeps mismatched prepared companions for explicit reconciliation", () => {
  const root = scratch();
  const journal = openFileJournal(root);
  const interrupted = spawnSync(
    process.execPath,
    args(WRITE, root, "companion", { key: "first", records: [record] }),
    { encoding: "utf8" },
  );
  expect(interrupted.status, interrupted.stderr).toBe(71);
  writeFileSync(join(root, record.path), '"unrelated"\n');
  expect(() => journal.withWriter(() => {})).toThrow("journal-record-mismatch");
  expect(readFileSync(join(root, record.path), "utf8")).toBe('"unrelated"\n');
  expect(existsSync(join(root, "journal", ".prepare.json"))).toBe(true);
  expect(journal.events()).toEqual([]);
});

it("serializes independent append processes without losing either event", async () => {
  const root = scratch();
  await Promise.all([
    exec(process.execPath, args(WRITE, root, "pause", { key: "one" })),
    exec(process.execPath, args(WRITE, root, "pause", { key: "two" })),
  ]);
  const events = openFileJournal(root).events();
  expect(events.map(({ seq }) => seq)).toEqual([1, 2]);
  expect(events.map(({ key }) => key).sort()).toEqual(["one", "two"]);
  expect(events[1]?.prevHash).toBe(events[0]?.hash);
});

it("bounds lock contention and permits a writer once the lock holder exits", async () => {
  const root = scratch();
  const child = spawn(process.execPath, args(WRITE, root, "hold"), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  try {
    const [data] = await once(child.stdout, "data");
    expect(String(data)).toBe("locked\n");
    expect(() => openFileJournal(root).withWriter(() => {})).toThrow("journal-busy");
  } finally {
    child.kill();
    await closed;
  }
  const journal = openFileJournal(root);
  const first = event("first");
  journal.withWriter((writer) => writer.commit([first]));
  expect(journal.events()).toEqual([first]);
}, 12_000);
