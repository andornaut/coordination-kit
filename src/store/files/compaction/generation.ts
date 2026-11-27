import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { isRecord } from "../../../core/encoding/pyjson.ts";
import { readJson, writeDurable } from "../../../core/files/durable.ts";
import { isCanonicalUuid } from "../../../core/ids.ts";
import { canonicalJson, sha256 } from "../../eventCodec.ts";
import type { FileProjection } from "../../fileProjection.ts";
import { StoreError } from "../../types.ts";
import {
  assertFileJournalFence,
  assertFileJournalReservation,
  fenceFileJournal,
  type FileJournal,
  type FileJournalReservation,
  type JournalBaseline,
  openFileJournal,
  readFileJournalFence,
  retiredFileJournalSnapshot,
} from "../journal.ts";
import {
  type CheckpointHead,
  type CheckpointPredecessor,
  type CheckpointReceipt,
  type CheckpointSelection,
  type CompactionCheckpoint,
  prepareCompactionCheckpoint,
  verifyCompactionCheckpoint,
  verifyCompactionSource,
} from "./checkpoint.ts";
import type { CompactionScope } from "./plan.ts";

const ACTIVE = "active-checkpoint.json";
const HEX = /^[a-f0-9]{64}$/;

type JournalSnapshot = ReturnType<FileJournal["snapshot"]>;

export interface FileCheckpointSource {
  readonly archives: readonly string[];
  readonly events: JournalSnapshot["events"];
  readonly previous: CheckpointPredecessor | undefined;
  readonly tail: JournalSnapshot;
}

export interface PreparedFileCheckpoint {
  readonly checkpoint: CompactionCheckpoint;
  readonly id: string;
  readonly receipt: CheckpointReceipt;
  readonly restoreDigest: string;
}

function readRegular(path: string): unknown {
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (file === undefined) {
    return undefined;
  }
  if (!file.isFile() || file.nlink !== 1) {
    throw new StoreError("checkpoint-path-invalid");
  }
  return readJson(path);
}

function metadata(root: string): string {
  const directory = join(root, "journal");
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new StoreError("checkpoint-journal-unavailable");
  }
  return directory;
}

function selector(value: unknown): CheckpointSelection {
  if (
    !isRecord(value) ||
    value.schema !== 2 ||
    !isCanonicalUuid(value.id) ||
    typeof value.digest !== "string" ||
    !HEX.test(value.digest) ||
    !isRecord(value.head) ||
    typeof value.head.hash !== "string" ||
    !HEX.test(value.head.hash) ||
    typeof value.head.seq !== "number" ||
    !Number.isSafeInteger(value.head.seq) ||
    value.head.seq <= 0 ||
    Object.keys(value).sort().join(",") !== "digest,head,id,schema" ||
    Object.keys(value.head).sort().join(",") !== "hash,seq"
  ) {
    throw new StoreError("checkpoint-selector-invalid");
  }
  return {
    digest: value.digest,
    head: { hash: value.head.hash, seq: value.head.seq },
    id: value.id,
  };
}

function separateRestore(root: string, restored: string): FileCheckpointSource {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    realpathSync(root) !== root ||
    !isAbsolute(restored) ||
    resolve(restored) !== restored ||
    realpathSync(restored) !== restored
  ) {
    throw new StoreError("checkpoint-restore-path-invalid");
  }
  for (const path of [relative(root, restored), relative(restored, root)]) {
    if (path === "" || !(path === ".." || path.startsWith("../"))) {
      throw new StoreError("checkpoint-restore-path-invalid");
    }
  }
  return readFileCheckpointSource(restored);
}

function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sourceDigest({ archives, previous, tail }: Omit<FileCheckpointSource, "events">): string {
  return digest(previous === undefined ? tail : { archives, previous: previous.selection, tail });
}

function activeSelection(root: string): CheckpointSelection | undefined {
  const directory = join(root, "journal");
  const journal = lstatSync(directory, { throwIfNoEntry: false });
  if (journal === undefined) {
    return undefined;
  }
  if (!journal.isDirectory()) {
    throw new StoreError("checkpoint-path-invalid");
  }
  const value = readRegular(join(directory, ACTIVE));
  return value === undefined ? undefined : selector(value);
}

function tailPath(root: string, previous?: CheckpointSelection): string {
  return previous === undefined ? root : join(root, "journal", `tail-${previous.id}`);
}

function predecessor(checkpoint: CompactionCheckpoint): CheckpointSelection | undefined {
  const prior = checkpoint.predecessor;
  if (prior === undefined) {
    return undefined;
  }
  const qualified = selector({ ...prior, schema: 2 });
  if (
    qualified.head.seq > checkpoint.head.seq ||
    canonicalJson(qualified) !== canonicalJson(prior)
  ) {
    throw new StoreError("checkpoint-predecessor-invalid");
  }
  return qualified;
}

function generation(
  root: string,
  selection?: CheckpointSelection,
): CheckpointPredecessor | undefined {
  if (selection === undefined) {
    return undefined;
  }
  const value = readRegular(join(metadata(root), `checkpoint-${selection.id}.json`));
  const checkpoint = verifyCompactionCheckpoint(value, selection);
  const prior = predecessor(checkpoint);
  if (prior?.id === selection.id) {
    throw new StoreError("checkpoint-predecessor-invalid");
  }
  assertFileJournalFence(tailPath(root, prior), selection);
  return { checkpoint, selection };
}

function journalFor(
  root: string,
  previous?: CheckpointPredecessor,
): {
  readonly baseline: JournalBaseline | undefined;
  readonly path: string;
} {
  return {
    baseline:
      previous === undefined
        ? undefined
        : {
            head: previous.checkpoint.head,
            keys: new Set(previous.checkpoint.entries.map(({ event }) => event.key)),
          },
    path: tailPath(root, previous?.selection),
  };
}

export function fileCheckpointJournal(root: string) {
  return journalFor(root, generation(root, activeSelection(root)));
}

export function assertCurrentJournal(path: string): void {
  if (readFileJournalFence(path) !== undefined) {
    throw new StoreError("checkpoint-selection-pending");
  }
}

function readyJournal(path: string, baseline?: JournalBaseline): FileJournal {
  assertCurrentJournal(path);
  return openFileJournal(path, baseline);
}

function archivedDigests(root: string, previous?: CheckpointPredecessor): string[] {
  const ids = new Set<string>();
  const archives: string[] = [];
  let current = previous;
  while (current !== undefined) {
    const { checkpoint, selection } = current;
    if (ids.has(selection.id)) {
      throw new StoreError("checkpoint-predecessor-invalid");
    }
    ids.add(selection.id);
    current = generation(root, predecessor(checkpoint));
    const { baseline, path } = journalFor(root, current);
    archives.push(digest(retiredFileJournalSnapshot(path, selection, baseline)));
  }
  return archives;
}

/** Inspect committed chains and companion digests, including retired journals, for restore proof. */
export function readFileCheckpointSource(root: string): FileCheckpointSource {
  const previous = generation(root, activeSelection(root));
  const { baseline, path } = journalFor(root, previous);
  const tail = readyJournal(path, baseline).snapshot();
  const events =
    previous === undefined
      ? tail.events
      : [...previous.checkpoint.entries.map(({ event }) => event), ...tail.events];
  return { archives: archivedDigests(root, previous), events, previous, tail };
}

export function fileCheckpointCandidate(
  { previous, tail }: FileCheckpointSource,
  scope: CompactionScope,
  anchor: CheckpointHead,
) {
  return prepareCompactionCheckpoint(tail.events, scope, anchor, previous);
}

/** Qualify a candidate against a separate restore of the selected generation and its archives. */
export function prepareFileCheckpoint(
  root: string,
  restored: string,
  scope: CompactionScope,
  anchor: CheckpointHead,
  reservation?: FileJournalReservation,
): PreparedFileCheckpoint {
  const source = readFileCheckpointSource(root);
  requireRepeatReservation(source.previous, reservation);
  assertFileJournalReservation(journalFor(root, source.previous).path, reservation);
  const restoredSource = separateRestore(root, restored);
  const restoreDigest = sourceDigest(restoredSource);
  if (sourceDigest(source) !== restoreDigest) {
    throw new StoreError("checkpoint-restore-mismatch");
  }
  const prepared = fileCheckpointCandidate(source, scope, anchor);
  assertReservationCheckpoint(prepared.checkpoint, reservation);
  return { ...prepared, id: randomUUID(), restoreDigest };
}

function requireRepeatReservation(
  previous: CheckpointPredecessor | undefined,
  reservation: FileJournalReservation | undefined,
): void {
  if (previous !== undefined && reservation === undefined) {
    throw new StoreError("compaction-reservation-required");
  }
}

function assertReservationCheckpoint(
  checkpoint: CompactionCheckpoint,
  reservation?: FileJournalReservation,
): void {
  if (
    reservation !== undefined &&
    (reservation.registryRevision !== checkpoint.registryRevision ||
      reservation.head.seq !== checkpoint.head.seq ||
      reservation.head.hash !== checkpoint.head.hash)
  ) {
    throw new StoreError("compaction-reservation-mismatch");
  }
}

function sameSelection(left?: CheckpointSelection, right?: CheckpointSelection): boolean {
  return left === undefined || right === undefined
    ? left === right
    : canonicalJson(left) === canonicalJson(right);
}

/** Fence the restored predecessor's exact journal and select the verified successor. */
export function selectFileCheckpoint(
  root: string,
  restored: string,
  prepared: PreparedFileCheckpoint,
  readScope: () => CompactionScope,
  anchor: CheckpointHead,
  reservation?: FileJournalReservation,
): void {
  const { checkpoint, id, receipt } = prepared;
  assertReservationCheckpoint(checkpoint, reservation);
  const selection = { ...receipt, id, schema: 2 };
  const fence = selector(selection);
  const directory = metadata(root);
  const activePath = join(directory, ACTIVE);
  const checkpointPath = join(directory, `checkpoint-${id}.json`);
  const restoredSource = separateRestore(root, restored);
  const previousSelection = restoredSource.previous?.selection;
  requireRepeatReservation(restoredSource.previous, reservation);
  if (sourceDigest(restoredSource) !== prepared.restoreDigest) {
    throw new StoreError("checkpoint-restore-mismatch");
  }
  verifyCompactionSource(
    checkpoint,
    receipt,
    restoredSource.tail.events,
    readScope(),
    anchor,
    restoredSource.previous,
  );
  const previous = generation(root, previousSelection);
  const archives = archivedDigests(root, previous);
  const { baseline, path } = journalFor(root, previous);
  function mustBeSourceOrSelected() {
    const active = activeSelection(root);
    if (!sameSelection(active, previousSelection) && !sameSelection(active, fence)) {
      if (previousSelection === undefined) {
        assertFileJournalFence(root, fence);
      }
      throw new StoreError("checkpoint-selection-conflict");
    }
    return active;
  }
  mustBeSourceOrSelected();
  fenceFileJournal(
    path,
    fence,
    (tail) => {
      mustBeSourceOrSelected();
      if (sourceDigest({ archives, previous, tail }) !== prepared.restoreDigest) {
        throw new StoreError("checkpoint-restore-mismatch");
      }
      verifyCompactionSource(checkpoint, receipt, tail.events, readScope(), anchor, previous);
      const staged = readRegular(checkpointPath);
      if (staged === undefined) {
        writeDurable(
          checkpointPath,
          `${canonicalJson(checkpoint)}
`,
        );
      } else {
        verifyCompactionCheckpoint(staged, receipt);
      }
    },
    () => {
      if (!sameSelection(mustBeSourceOrSelected(), fence)) {
        writeDurable(
          activePath,
          `${canonicalJson(selection)}
`,
        );
      }
    },
    reservation,
    baseline,
  );
}

/** Open the selected checkpoint and its unfenced ordinary tail. */
export function selectedFileCheckpoint(
  root: string,
): Pick<FileProjection, "assertCurrent" | "checkpoint" | "journal"> | undefined {
  const previous = generation(root, activeSelection(root));
  const { baseline, path } = journalFor(root, previous);
  const journal = readyJournal(path, baseline);
  if (previous === undefined) {
    return undefined;
  }
  const { digest: hash, head } = previous.selection;
  return {
    assertCurrent: () => assertCurrentJournal(path),
    checkpoint: { receipt: { digest: hash, head }, value: previous.checkpoint },
    journal,
  };
}
