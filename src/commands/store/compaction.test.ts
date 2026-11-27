import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { main } from "../../cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../../core/cli/io.ts";
import { gameLayout } from "../../core/configuration/layout.ts";
import { TEST_CLOCK, TEST_CONTEXT, TEST_GIT } from "../../core/testFixtures.ts";
import { updateRegistry } from "../../registry/store.ts";
import { showBrief, storeReview } from "../../review/storeBrief.ts";
import { Store } from "../../store/db.ts";
import {
  fileCheckpointJournal,
  readFileCheckpointSource,
} from "../../store/files/compaction/generation.ts";
import {
  fenceFileJournal,
  openFileJournal,
  readFileJournalReservation,
  retiredFileJournalSnapshot,
} from "../../store/files/journal.ts";
import { activateMigration, prepareMigration } from "../../store/files/migration.ts";
import { closeMessage, messageStatus, sendMessage } from "../../store/messages/messages.ts";
import { recordSession } from "../../store/sessions/handoffs.ts";
import { COORDINATOR, GAME, storeFixture, TECH } from "../../store/testStore.ts";

// These command cases exercise real registry and journal lock processes.
vi.setConfig({ testTimeout: 15_000 });

const OWNER = { nativeId: TECH, role: "archies-dog-walks/tech" };
const SENDER = { nativeId: COORDINATOR, role: "game-coordinator" };
const BODY = "Historical test original";
const REPLACEMENT = "work/fixture#verified-original";
const ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";

function recentId(index: number): string {
  return `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`;
}

function fixture(hasReplacement = true) {
  const { base, layout, root } = storeFixture();
  execFileSync("git", ["-C", root, "init", "-q", "--initial-branch=main"]);
  writeFileSync(join(root, ".gitignore"), "/var/\n");
  const outside = join(base, "prior-state");
  writeFileSync(
    join(layout.varDir, "work-protocol.json"),
    JSON.stringify({ schema: 2, stateRoot: outside }),
  );
  const store = Store.forLayout(TEST_CONTEXT, layout);
  const start = (key: string) =>
    recordSession(store, OWNER, { cwd: "/fixture", harness: "claude", key, version: "3.4.4" });
  start("anchor");
  const routine = start("historical");
  sendMessage(store, SENDER, { body: BODY, id: ID, intent: "queue", to: OWNER.role });
  closeMessage(store, OWNER, ID, { evidence: hasReplacement ? [REPLACEMENT] : [] });
  const closeSeq = store.head().seq;
  store.transaction(() => {
    for (let index = 0; index < 100; index++) {
      start(`recent-${index}`);
      const id = recentId(index);
      sendMessage(store, SENDER, { body: "Recent original", id, intent: "queue", to: OWNER.role });
      closeMessage(store, OWNER, id, { evidence: [REPLACEMENT] });
    }
  });
  const head = store.head();
  store.close();
  const { receipt: cutover } = prepareMigration(
    TEST_GIT,
    layout,
    join(base, "backup.db"),
    join(base, "restore.db"),
  );
  activateMigration(TEST_GIT, layout, cutover.id);
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

it("replays a closed-history batch on an independent restore and switches only the reviewed selection", async () => {
  const { common, head, restore, run, target, writeEvidence } = fixture(false);
  const mode = ["--closed-history", "decision-closed-history"];
  const original = openFileJournal(target).snapshot();
  expect(await run(["compaction-prepare", ...common])).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-message-replacement-unverified\n",
  });
  const preview = await run(["compaction-plan", ...mode, "--restore", restore]);
  expect(preview.code, preview.err).toBe(EXIT_OK);
  const plan = JSON.parse(preview.out) as {
    evidence: { selected: string[] };
    replay: unknown;
    selected: string[];
  };
  expect(plan.selected).toEqual([ID]);
  expect(plan.replay).toMatchObject({ stateEquivalent: true, removedBodies: 1 });
  expect(openFileJournal(target).snapshot()).toEqual(original);
  writeEvidence(plan.evidence);
  const prepare = ["compaction-prepare", ...mode, ...common, "--id", OTHER_ID];
  expect(await run(prepare)).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-reservation-required\n",
  });
  expect(
    await run([
      "compaction-reserve",
      "--id",
      OTHER_ID,
      "--head-seq",
      String(head.seq),
      "--head-hash",
      head.hash,
      "--registry-revision",
      "1",
    ]),
  ).toMatchObject({ code: EXIT_OK });
  writeEvidence({ ...plan.evidence, selected: [recentId(0)] });
  expect(await run(prepare)).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: closed-history-evidence-mismatch\n",
  });
  writeEvidence(plan.evidence);
  const prepared = await run(prepare);
  expect(prepared.code, prepared.err).toBe(EXIT_OK);
  expect(openFileJournal(target).snapshot()).toEqual(original);
  const { id } = JSON.parse(prepared.out) as { id: string };
  const activated = await run([
    "compaction-activate",
    ...mode,
    ...common,
    "--id",
    id,
    "--approval",
    "decision-activation",
  ]);
  expect(activated.code, activated.err).toBe(EXIT_OK);
  expect(readFileCheckpointSource(target).previous?.selection.head).toEqual(head);
});

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
  const store = Store.readLayout(TEST_CONTEXT, layout)!;
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
  updateRegistry(TEST_CLOCK, layout, 1, () => {});
  expect(
    await run(["compaction-activate", "--approval", "decision-1", "--id", id, ...cleanArgs]),
  ).toMatchObject({ code: EXIT_INVALID, err: "coordination-kit: compaction-evidence-changed\n" });
  expect(existsSync(join(target, "journal", "active-checkpoint.json"))).toBe(false);
});

it("binds prepare and interrupted activation to one acquisition and exact candidate", async () => {
  const { base, common, head, layout, receipt, restore, run, selectors, target, writeEvidence } =
    fixture();
  const request = [
    "--id",
    OTHER_ID,
    "--head-seq",
    String(head.seq),
    "--head-hash",
    head.hash,
    "--registry-revision",
    "1",
  ];
  const journal = openFileJournal(target);
  const original = journal.snapshot();
  const legacyPath = join(base, "legacy-receipt.json");
  const alternatePath = join(base, "alternate-receipt.json");
  const at = (file: string) => common.map((arg) => (arg === receipt ? file : arg));
  const legacyPrepare = await run(["compaction-prepare", ...at(legacyPath)]);
  expect(legacyPrepare.code).toBe(EXIT_OK);
  const legacy = JSON.parse(legacyPrepare.out) as { id: string };
  expect(await run(["compaction-reserve", ...request], TECH)).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: not-coordinator\n",
  });
  const reserved = await run(["compaction-reserve", ...request]);
  expect(reserved.code).toBe(EXIT_OK);
  const first = JSON.parse(reserved.out) as { nonce: string };
  expect(await run(["compaction-reserve", ...request])).toEqual(reserved);
  expect(journal.snapshot()).toEqual(original);
  const markedRestore = join(base, "marked-restore");
  cpSync(target, markedRestore, { recursive: true });
  expect(
    await run([
      "compaction-prepare",
      "--id",
      OTHER_ID,
      ...common.map((arg) => (arg === restore ? markedRestore : arg)),
    ]),
  ).toMatchObject({ code: EXIT_INVALID, err: "coordination-kit: compaction-restore-reserved\n" });
  expect(await run(["compaction-prepare", ...common])).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-reserved\n",
  });
  const activation = (id: string, file: string) => [
    "compaction-activate",
    "--approval",
    "decision-1",
    "--id",
    id,
    ...at(file),
  ];
  expect(await run(activation(legacy.id, legacyPath))).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-reserved\n",
  });
  const prior = await run(["compaction-prepare", "--id", OTHER_ID, ...common]);
  expect(prior.code).toBe(EXIT_OK);
  const old = JSON.parse(prior.out) as { id: string };
  expect(await run(["compaction-cancel", ...request, "--nonce", first.nonce])).toMatchObject({
    code: EXIT_OK,
  });
  expect(await run(activation(old.id, receipt))).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-reservation-required\n",
  });

  const next = await run(["compaction-reserve", ...request]);
  expect(next.code).toBe(EXIT_OK);
  const { nonce } = JSON.parse(next.out) as { nonce: string };
  expect(nonce).not.toBe(first.nonce);
  expect(await run(["compaction-cancel", ...request, "--nonce", first.nonce])).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-reservation-mismatch\n",
  });
  expect(await run(activation(old.id, receipt))).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-reservation-mismatch\n",
  });
  const again = await run(["compaction-prepare", "--id", OTHER_ID, ...at(alternatePath)]);
  expect(again.code).toBe(EXIT_OK);
  const { digest, id } = JSON.parse(again.out) as { digest: string; id: string };
  expect(id).not.toBe(old.id);
  const selected = join(base, "distinct-candidate.json");
  writeEvidence({ ...selectors, routineEventSequences: [] });
  const distinct = await run(["compaction-prepare", "--id", OTHER_ID, ...at(selected)]);
  expect(distinct.code).toBe(EXIT_OK);
  expect((JSON.parse(distinct.out) as { id: string }).id).not.toBe(id);
  writeEvidence();

  const activeReservation = readFileJournalReservation(target)!;
  expect(() =>
    fenceFileJournal(
      target,
      { digest, head, id },
      () => {},
      () => {
        throw new Error("interrupted");
      },
      activeReservation,
    ),
  ).toThrow("interrupted");
  expect(await run(["compaction-cancel", ...request, "--nonce", nonce])).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: compaction-source-already-fenced\n",
  });
  expect(() => Store.readLayout(TEST_CONTEXT, layout)).toThrow("checkpoint-selection-pending");
  expect(await run(activation(id, alternatePath))).toMatchObject({ code: EXIT_OK });
  expect(readFileJournalReservation(target)).toBeUndefined();
  expect(await run(activation(old.id, receipt))).toMatchObject({
    code: EXIT_INVALID,
    err: "coordination-kit: checkpoint-fence-mismatch\n",
  });
  const selector = join(target, "journal", "active-checkpoint.json");
  const candidate = join(target, "journal", `checkpoint-${id}.json`);
  const state = [selector, candidate].map((file) => ({
    bytes: readFileSync(file),
    stat: statSync(file),
  }));
  expect(await run(activation(id, alternatePath))).toMatchObject({ code: EXIT_OK });
  for (const [index, file] of [selector, candidate].entries()) {
    expect(readFileSync(file)).toEqual(state[index]!.bytes);
    expect(statSync(file)).toMatchObject({
      ino: state[index]!.stat.ino,
      mtimeMs: state[index]!.stat.mtimeMs,
    });
  }
});

it("rotates three real generations and preserves expired bodies, exact keys and review continuity", async () => {
  const { base, common, layout, receipt, restore, run, selectors, target, writeEvidence } =
    fixture();
  const game = gameLayout(layout, GAME);
  mkdirSync(game.busDir, { recursive: true });
  const cursor = join(game.busDir, "events.cursor");
  writeFileSync(cursor, "cursor fixture");
  writeFileSync(
    layout.routeFile,
    JSON.stringify({ host: GAME, schema: 2, state: "active", targets: [OWNER.role] }),
  );
  const activation = (id: string, paths: string[]) => [
    "compaction-activate",
    "--id",
    id,
    "--approval",
    "decision-1",
    ...paths,
  ];
  const first = await run(["compaction-prepare", ...common]);
  expect(first.code, first.err).toBe(EXIT_OK);
  const firstId = (JSON.parse(first.out) as { id: string }).id;
  expect(await run(activation(firstId, common))).toMatchObject({ code: EXIT_OK });
  const initial = readFileCheckpointSource(target).previous!;
  const firstTombstone = initial.checkpoint.entries.find(({ event }) => event.payload.id === ID)!;
  expect(firstTombstone.reducedDigest).toBeTypeOf("string");
  const originalBatch = join(target, "journal", "batches", "0000000000000001.json");
  const originalBytes = readFileSync(originalBatch);
  let prior = initial;

  for (const index of [0, 1]) {
    // eslint-disable-next-line no-await-in-loop
    await rotate(index);
  }

  async function rotate(index: number) {
    const old = Store.forLayout(TEST_CONTEXT, layout);
    try {
      old.transaction(() => {
        recordSession(old, OWNER, {
          cwd: "/fixture",
          harness: "claude",
          key: `additional-${index}`,
          version: "4.1.1",
        });
        const id = recentId(100 + index);
        sendMessage(old, SENDER, { body: "Later original", id, intent: "queue", to: OWNER.role });
        closeMessage(old, OWNER, id, { evidence: [REPLACEMENT] });
      });
      const durable = fileCheckpointJournal(target);
      const oldBody = old.eventByKey(`msg.sent:${recentId(index)}`)!;
      const close = old.eventByKey(`msg.closed:${recentId(index)}`)!;
      const routine = old.eventByKey(`session.started:recent-${index}`)!;
      const head = old.verify().head;
      const proof = {
        ...selectors,
        head,
        messages: [
          { closeSeq: close.seq, id: recentId(index), owner: OWNER.role, replacement: REPLACEMENT },
        ],
        routineEventSequences: [routine.seq],
      };
      writeEvidence(proof);
      const restored = join(base, `repeat-restore-${index}`);
      const externalReceipt = join(base, `repeat-receipt-${index}.json`);
      cpSync(target, restored, { recursive: true });
      const args = common.map((arg) =>
        arg === restore ? restored : arg === receipt ? externalReceipt : arg,
      );
      const reserve = [
        "--id",
        recentId(200 + index),
        "--head-seq",
        String(head.seq),
        "--head-hash",
        head.hash,
        "--registry-revision",
        "1",
      ];
      const plan = await run(["compaction-plan"]);
      expect(plan.code, plan.err).toBe(EXIT_OK);
      expect(plan.out).toContain('"reason":"already-compacted"');
      expect(await run(["compaction-prepare", ...args])).toMatchObject({
        code: EXIT_INVALID,
        err: "coordination-kit: compaction-reservation-required\n",
      });
      const reserved = await run(["compaction-reserve", ...reserve]);
      expect(reserved.code, reserved.err).toBe(EXIT_OK);
      const acquired = readFileJournalReservation(durable.path)!;
      expect(() => old.transaction(() => {})).toThrow("compaction-reserved");
      const currentRead = Store.readLayout(TEST_CONTEXT, layout)!;
      try {
        expect(currentRead.head()).toEqual(head);
      } finally {
        currentRead.close();
      }
      const cancel = ["compaction-cancel", ...reserve, "--nonce", acquired.nonce];
      const prepare = ["compaction-prepare", "--id", acquired.id, ...args];
      if (index === 0) {
        const archivedCompanion = retiredFileJournalSnapshot(target, initial.selection).records[0]!;
        const restoredCompanion = join(restored, archivedCompanion.path);
        const saved = readFileSync(restoredCompanion);
        writeFileSync(restoredCompanion, "altered replica");
        expect(await run(prepare)).toMatchObject({
          code: EXIT_INVALID,
          err: "coordination-kit: journal-record-mismatch\n",
        });
        writeFileSync(restoredCompanion, saved);
        writeEvidence({ ...proof, messages: [...proof.messages, ...selectors.messages] });
        expect(await run(prepare)).toMatchObject({
          code: EXIT_INVALID,
          err: "coordination-kit: checkpoint-selection-unqualified\n",
        });
        writeEvidence(proof);
        expect(await run(cancel)).toMatchObject({ code: EXIT_OK });
        expect(old.transaction(() => old.head())).toEqual(head);
        expect(await run(["compaction-reserve", ...reserve])).toMatchObject({ code: EXIT_OK });
      }
      const result = await run(prepare);
      expect(result.code, result.err).toBe(EXIT_OK);
      const { digest, id } = JSON.parse(result.out) as { digest: string; id: string };
      const activate = () => run(activation(id, args));
      const reservation = readFileJournalReservation(durable.path)!;
      if (index === 0) {
        expect(() =>
          fenceFileJournal(
            durable.path,
            { digest, head, id },
            () => {},
            () => {
              throw new Error("interrupted");
            },
            reservation,
            durable.baseline,
          ),
        ).toThrow("interrupted");
        expect(() => Store.readLayout(TEST_CONTEXT, layout)).toThrow(
          "checkpoint-selection-pending",
        );
        expect(
          await run(["compaction-cancel", ...reserve, "--nonce", reservation.nonce]),
        ).toMatchObject({
          code: EXIT_INVALID,
          err: "coordination-kit: compaction-source-already-fenced\n",
        });
        expect(await activate()).toMatchObject({ code: EXIT_OK });
      } else {
        // Controlled overlap: review reads the current store, activates inside its native
        // survey, then records the exact slot in the newly selected store.
        const slot = Date.parse("2026-11-18T15:30:00Z") / 1000;
        const context = {
          async collect() {
            expect(await activate()).toMatchObject({ code: EXIT_OK });
            return { collection_budget: {}, history: {}, question_state: {}, worker_health: {} };
          },
          env: {},
          layout,
          clock: TEST_CLOCK,
        };
        const reviewed = await storeReview(context, game, slot);
        expect(reviewed.status).toBe("delivered");
        expect(showBrief(TEST_CONTEXT, layout, { slot }).result).toEqual(reviewed);
        expect(await storeReview(context, game, slot)).toEqual(reviewed);
      }
      expect(await activate()).toMatchObject({ code: EXIT_OK });
      expect(() => old.transaction(() => {})).toThrow("journal-corrupt");
      writeEvidence();
      expect(await run(activation(firstId, common))).toMatchObject({
        code: EXIT_INVALID,
        err: "coordination-kit: checkpoint-selection-conflict\n",
      });
      writeEvidence(proof);
      const selected = readFileCheckpointSource(target).previous!;
      expect(selected.checkpoint.predecessor).toEqual(prior.selection);
      expect(selected.checkpoint.entries[firstTombstone.event.seq - 1]).toEqual(firstTombstone);
      for (const entry of prior.checkpoint.entries.filter(
        ({ reducedDigest }) => reducedDigest !== undefined,
      )) {
        expect(selected.checkpoint.entries[entry.event.seq - 1]).toEqual(entry);
      }
      prior = selected;
      const reopened = Store.forLayout(TEST_CONTEXT, layout);
      try {
        expect(reopened.rebuild()).toEqual(reopened.verify());
        expect(messageStatus(reopened, ID, true)).toMatchObject({
          bodyExpired: true,
          state: "handled",
        });
        expect(messageStatus(reopened, recentId(index), true)).toMatchObject({
          bodyExpired: true,
          state: "handled",
        });
        expect(reopened.eventByKey(oldBody.key)).toMatchObject({
          hash: oldBody.hash,
          prevHash: oldBody.prevHash,
          seq: oldBody.seq,
        });
        expect(
          sendMessage(reopened, SENDER, {
            body: "Recent original",
            id: recentId(index),
            intent: "queue",
            to: OWNER.role,
          }).duplicate,
        ).toBe(true);
      } finally {
        reopened.close();
      }
      expect(readFileSync(originalBatch)).toEqual(originalBytes);
      expect(readFileSync(cursor, "utf8")).toBe("cursor fixture");
    } finally {
      old.close();
    }
  }
}, 30_000);
