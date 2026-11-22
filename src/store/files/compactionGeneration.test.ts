import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { Store } from "../db.ts";
import {
  prepareFileCheckpoint,
  selectedFileCheckpoint,
  selectFileCheckpoint,
} from "./compactionGeneration.ts";
import { fenceFileJournal, openFileJournal } from "./journal.ts";

const ROLE = "fixture-kit";
const NATIVE_ID = "00000000-0000-4000-8000-000000000011";
const ACTOR = { nativeId: NATIVE_ID, role: ROLE };

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "coordination-checkpoint-generation-"));
  const root = join(base, "source");
  const restored = join(base, "restored");
  const journal = openFileJournal(root);
  const store = Store.openFileProjection(root, { journal, records: () => [] });
  const first = store.append({ actor: ACTOR, key: "anchor", kind: "fixture.anchor", payload: {} });
  const anchor = { hash: first.event.hash, seq: first.event.seq };
  store.transaction(() => {
    for (let index = 0; index <= 100; index += 1) {
      store.append({
        actor: ACTOR,
        key: `session-${index}`,
        kind: "session.started",
        payload: { cwd: `/fixture/${index}`, harness: "codex", nativeId: NATIVE_ID, role: ROLE },
      });
    }
  });
  const head = store.head();
  store.close();
  cpSync(root, restored, { recursive: true });
  const scope = {
    registeredGames: new Set<string>(),
    registeredRoles: new Set([ROLE]),
    registryRevision: 1,
    verifiedEvidence: {
      head,
      messageIds: new Set<string>(),
      registryRevision: 1,
      routineEventSequences: new Set([2]),
    },
  };
  return { anchor, head, journal, restored, root, scope };
}

it("fences the old journal and opens an exact selected generation using a separate restore", () => {
  const { anchor, head, journal, restored, root, scope } = fixture();
  const oldBatch = join(root, "journal", "batches", "0000000000000001.json");
  const oldBytes = readFileSync(oldBatch);
  const prepared = prepareFileCheckpoint(root, restored, scope, anchor);
  expect(selectedFileCheckpoint(root)).toBeUndefined();
  expect(() =>
    selectFileCheckpoint(
      root,
      restored,
      prepared,
      () => ({ ...scope, registryRevision: 2 }),
      anchor,
    ),
  ).toThrow("checkpoint-evidence-mismatch");
  expect(selectedFileCheckpoint(root)).toBeUndefined();

  selectFileCheckpoint(root, restored, prepared, () => scope, anchor);
  selectFileCheckpoint(root, restored, prepared, () => scope, anchor);
  expect(() => journal.events()).toThrow("journal-corrupt");
  expect(readFileSync(oldBatch)).toEqual(oldBytes);

  const selected = selectedFileCheckpoint(root)!;
  const replay = Store.openFileProjection(root, { ...selected, records: () => [] });
  try {
    expect(replay.verify().head).toEqual(head);
    expect(replay.eventByKey("session-0")?.payload.cwd).toBeUndefined();
    const next = replay.append({ actor: ACTOR, key: "after", kind: "fixture.append", payload: {} });
    expect(next.event).toMatchObject({ prevHash: head.hash, seq: head.seq + 1 });
    expect(selected.journal.events()).toEqual([next.event]);
  } finally {
    replay.close();
  }
  expect(openFileJournal(restored).events()).toHaveLength(head.seq);
});

it("reports pending after a fence interruption and resumes only the exact verified selection", () => {
  const { anchor, restored, root, scope } = fixture();
  expect(() => prepareFileCheckpoint(root, root, scope, anchor)).toThrow(
    "checkpoint-restore-path-invalid",
  );
  const prepared = prepareFileCheckpoint(root, restored, scope, anchor);
  expect(() =>
    fenceFileJournal(
      root,
      { ...prepared.receipt, id: prepared.id },
      () => {},
      () => {
        throw new Error("selection interrupted");
      },
    ),
  ).toThrow("selection interrupted");
  expect(() => selectedFileCheckpoint(root)).toThrow("checkpoint-selection-pending");
  expect(existsSync(join(root, "journal", `checkpoint-${prepared.id}.json`))).toBe(false);
  selectFileCheckpoint(root, restored, prepared, () => scope, anchor);
  expect(selectedFileCheckpoint(root)?.checkpoint?.receipt).toEqual(prepared.receipt);
});
