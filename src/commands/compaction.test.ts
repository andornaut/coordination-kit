import { execFileSync } from "node:child_process";
import { cpSync, existsSync, linkSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, main } from "../cli.ts";
import { updateRegistry } from "../registry/store.ts";
import { Store } from "../store/db.ts";
import { fenceFileJournal, openFileJournal } from "../store/files/journal.ts";
import { activateMigration, prepareMigration } from "../store/files/migration.ts";
import { recordSession } from "../store/handoffs.ts";
import { closeMessage, messageStatus, sendMessage } from "../store/messages.ts";
import { COORDINATOR, storeFixture, TECH } from "../store/testStore.ts";

const OWNER = { nativeId: TECH, role: "archies-dog-walks/tech" };
const SENDER = { nativeId: COORDINATOR, role: "game-coordinator" };
const BODY = "Historical test original";
const REPLACEMENT = "work/fixture#verified-original";
const ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";

function fixture() {
  const { base, layout, root } = storeFixture();
  execFileSync("git", ["-C", root, "init", "-q", "--initial-branch=main"]);
  writeFileSync(join(root, ".gitignore"), "/var/\n");
  const outside = join(base, "prior-state");
  writeFileSync(
    join(layout.varDir, "work-protocol.json"),
    JSON.stringify({ schema: 2, stateRoot: outside }),
  );
  const store = Store.forLayout(layout);
  const start = (key: string) =>
    recordSession(store, OWNER, { cwd: "/fixture", harness: "claude", key, version: "3.4.4" });
  start("anchor");
  const routine = start("historical");
  sendMessage(store, SENDER, { body: BODY, id: ID, intent: "queue", to: OWNER.role });
  closeMessage(store, OWNER, ID, { evidence: [REPLACEMENT] });
  const closeSeq = store.head().seq;
  store.transaction(() => {
    for (let index = 0; index < 100; index++) {
      start(`recent-${index}`);
      const id = `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`;
      sendMessage(store, SENDER, { body: "Recent original", id, intent: "queue", to: OWNER.role });
      closeMessage(store, OWNER, id);
    }
  });
  const head = store.head();
  store.close();
  const { receipt: cutover } = prepareMigration(
    layout,
    join(base, "backup.db"),
    join(base, "restore.db"),
  );
  activateMigration(layout, cutover.id);
  const target = join(layout.varDir, "coordination");
  const restore = join(base, "restored-journal");
  cpSync(target, restore, { recursive: true });
  const evidence = join(base, "evidence.json");
  const receipt = join(base, "receipt.json");
  const selectors = {
    head,
    messages: [{ closeSeq, id: ID, owner: OWNER.role, replacement: REPLACEMENT }],
    registryRevision: 1,
    routineEventSequences: [routine.seq],
    schema: 1,
  };
  const writeEvidence = (value: unknown = selectors) => {
    writeFileSync(evidence, JSON.stringify(value));
  };
  writeEvidence();
  const common = ["--restore", restore, "--evidence", evidence, "--receipt", receipt];
  const run = async (args: string[], nativeId = COORDINATOR) => {
    let out = "";
    let err = "";
    const code = await main(
      {
        cwd: base,
        env: { CLAUDE_CODE_SESSION_ID: nativeId },
        err: (text) => (err += text),
        out: (text) => (out += text),
      },
      ["--root", root, "store", ...args],
    );
    return { code, err, out };
  };
  return { base, common, head, layout, receipt, restore, run, selectors, target, writeEvidence };
}

it("requires exact qualification, preserves original loose records and resumes the same fenced ID", async () => {
  const { base, common, head, layout, receipt, restore, run, selectors, target, writeEvidence } =
    fixture();
  const oldBatch = join(target, "journal", "batches", "0000000000000001.json");
  const oldBytes = readFileSync(oldBatch);
  const original = readdirSync(target, { recursive: true }).sort();

  expect(await run(["compaction-prepare", ...common], TECH)).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: not-coordinator\n",
  });
  const result = await run(["compaction-prepare", ...common]);
  expect(result).toMatchObject({ code: EXIT_OK, err: "" });
  const bytes = readFileSync(receipt, "utf8");
  expect(result.out.length).toBeLessThan(1024);
  expect(JSON.parse(result.out)).toEqual(JSON.parse(bytes));
  expect(bytes).not.toContain(BODY);
  expect(bytes).not.toContain("entries");
  expect(readdirSync(target, { recursive: true }).sort()).toEqual(original);
  expect(await run(["compaction-prepare", ...common])).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-receipt-exists\n",
  });
  expect(readFileSync(receipt, "utf8")).toBe(bytes);
  const { digest, id } = JSON.parse(bytes) as { digest: string; id: string };
  expect(await run(["compaction-activate", "--id", id, ...common])).toMatchObject({
    code: EXIT_USAGE,
  });
  expect(
    await run(["compaction-activate", "--approval", "decision-1", "--id", OTHER_ID, ...common]),
  ).toMatchObject({ code: EXIT_INVALID, err: "coordination-kit: compaction-receipt-mismatch\n" });

  const activate = ["compaction-activate", "--approval", "decision-1", "--id", id, ...common];
  writeEvidence({ ...selectors, routineEventSequences: [] });
  expect(await run(activate)).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-receipt-mismatch\n",
  });
  writeEvidence();
  const otherRestore = join(base, "alternate-restore");
  cpSync(restore, otherRestore, { recursive: true });
  expect(await run(activate.map((arg) => (arg === restore ? otherRestore : arg)))).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-receipt-mismatch\n",
  });

  expect(() =>
    fenceFileJournal(
      target,
      { digest, head, id },
      () => {},
      () => {
        throw new Error("interrupted");
      },
    ),
  ).toThrow("interrupted");
  expect(await run(activate)).toMatchObject({ code: EXIT_OK, err: "" });
  expect(await run(activate)).toMatchObject({ code: EXIT_OK, err: "" });
  expect(readFileSync(oldBatch)).toEqual(oldBytes);
  expect(openFileJournal(restore).snapshot().events.at(-1)).toMatchObject(head);
  const store = Store.readLayout(layout)!;
  try {
    expect(store.verify().head).toEqual(head);
    expect(messageStatus(store, ID, true)).toMatchObject({ bodyExpired: true, state: "handled" });
    expect(
      store.events().find(({ seq }) => seq === selectors.routineEventSequences[0])?.payload,
    ).not.toHaveProperty("cwd");
  } finally {
    store.close();
  }
});

it("refuses unbound or stale proof, unqualified replacements and non-independent paths", async () => {
  const { base, common, layout, receipt, restore, run, selectors, target, writeEvidence } =
    fixture();
  const prepare = ["compaction-prepare", ...common];
  writeEvidence({ ...selectors, messages: [], routineEventSequences: [] });
  expect(await run(prepare)).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: checkpoint-selection-unqualified\n",
  });
  writeEvidence({
    ...selectors,
    messages: [{ ...selectors.messages[0], replacement: "wrong-ref" }],
  });
  expect(await run(prepare)).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-message-replacement-unverified\n",
  });
  writeEvidence({ ...selectors, head: { ...selectors.head, hash: "a".repeat(64) } });
  expect(await run(prepare)).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: checkpoint-evidence-mismatch\n",
  });
  writeEvidence();

  const linked = join(restore, "linked-record");
  linkSync(join(target, "journal", "batches", "0000000000000001.json"), linked);
  expect(await run(prepare)).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-restore-not-independent\n",
  });
  const independent = join(base, "independent");
  cpSync(target, independent, { recursive: true });
  const cleanArgs = common.map((arg) => (arg === restore ? independent : arg));
  const overlap = cleanArgs.map((arg) => (arg === receipt ? join(target, "receipt.json") : arg));
  expect(await run(["compaction-prepare", ...overlap])).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-path-overlap\n",
  });
  expect(existsSync(receipt)).toBe(false);
  const prepared = await run(["compaction-prepare", ...cleanArgs]);
  expect(prepared.code).toBe(EXIT_OK);
  const { id } = JSON.parse(prepared.out) as { id: string };
  updateRegistry(layout, 1, () => {});
  expect(
    await run(["compaction-activate", "--approval", "decision-1", "--id", id, ...cleanArgs]),
  ).toMatchObject({ code: EXIT_INVALID, err: "coordination-kit: compaction-evidence-changed\n" });
  expect(existsSync(join(target, "journal", "active-checkpoint.json"))).toBe(false);
});
