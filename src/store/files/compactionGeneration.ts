import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { isCanonicalUuid } from "../../adapters/shared/ids.ts";
import { isRecord } from "../../adapters/shared/pyjson.ts";
import { readJson, writeDurable } from "../../durable.ts";
import { canonicalJson } from "../eventCodec.ts";
import type { FileProjection } from "../fileProjection.ts";
import { StoreError } from "../types.ts";
import {
  type CheckpointHead,
  type CheckpointReceipt,
  type CompactionCheckpoint,
  prepareCompactionCheckpoint,
  verifyCompactionCheckpoint,
  verifyCompactionSource,
} from "./compactionCheckpoint.ts";
import type { CompactionScope } from "./compactionPlan.ts";
import {
  assertFileJournalFence,
  fenceFileJournal,
  type FileJournal,
  openFileJournal,
  readFileJournalFence,
} from "./journal.ts";

const ACTIVE = "active-checkpoint.json";
const HEX = /^[a-f0-9]{64}$/;

interface Selection {
  readonly digest: string;
  readonly head: CheckpointHead;
  readonly id: string;
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

function selector(value: unknown): Selection {
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

function separateRestore(root: string, restored: string): ReturnType<typeof openFileJournal> {
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
  return openFileJournal(restored);
}

function snapshotDigest(snapshot: ReturnType<FileJournal["snapshot"]>): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/** Qualify a read-only candidate against a separately restored copy of the full history. */
export function prepareFileCheckpoint(
  root: string,
  restored: string,
  scope: CompactionScope,
  anchor: CheckpointHead,
): PreparedFileCheckpoint {
  const source = openFileJournal(root).snapshot();
  const restoredSource = separateRestore(root, restored).snapshot();
  const restoreDigest = snapshotDigest(restoredSource);
  if (snapshotDigest(source) !== restoreDigest) {
    throw new StoreError("checkpoint-restore-mismatch");
  }
  return {
    ...prepareCompactionCheckpoint(source.events, scope, anchor),
    id: randomUUID(),
    restoreDigest,
  };
}

/** Select the same prepared checkpoint under the old journal's exclusive writer lock. */
export function selectFileCheckpoint(
  root: string,
  restored: string,
  prepared: PreparedFileCheckpoint,
  readScope: () => CompactionScope,
  anchor: CheckpointHead,
): void {
  const { checkpoint, id, receipt } = prepared;
  const selection = { ...receipt, id, schema: 2 };
  const fence = selector(selection);
  const directory = metadata(root);
  const activePath = join(directory, ACTIVE);
  const checkpointPath = join(directory, `checkpoint-${id}.json`);
  const restoredSource = separateRestore(root, restored).snapshot();
  if (snapshotDigest(restoredSource) !== prepared.restoreDigest) {
    throw new StoreError("checkpoint-restore-mismatch");
  }
  verifyCompactionSource(checkpoint, receipt, restoredSource.events, readScope(), anchor);
  fenceFileJournal(
    root,
    fence,
    (source) => {
      if (snapshotDigest(source) !== prepared.restoreDigest) {
        throw new StoreError("checkpoint-restore-mismatch");
      }
      const active = readRegular(activePath);
      if (active !== undefined && canonicalJson(active) !== canonicalJson(selection)) {
        throw new StoreError("checkpoint-selection-conflict");
      }
      verifyCompactionSource(checkpoint, receipt, source.events, readScope(), anchor);
      const previous = readRegular(checkpointPath);
      if (previous === undefined) {
        writeDurable(checkpointPath, canonicalJson(checkpoint) + "\n");
      } else {
        verifyCompactionCheckpoint(previous, receipt);
      }
    },
    () => {
      if (readRegular(activePath) === undefined) {
        writeDurable(activePath, canonicalJson(selection) + "\n");
      }
    },
  );
}

/** Open only the exact fenced checkpoint and its normal append-only tail. */
export function selectedFileCheckpoint(
  root: string,
): Pick<FileProjection, "checkpoint" | "journal"> | undefined {
  const directory = join(root, "journal");
  const journal = lstatSync(directory, { throwIfNoEntry: false });
  if (journal === undefined) {
    return undefined;
  }
  if (!journal.isDirectory()) {
    throw new StoreError("checkpoint-path-invalid");
  }
  const active = readRegular(join(directory, ACTIVE));
  if (active === undefined) {
    if (readFileJournalFence(root) !== undefined) {
      throw new StoreError("checkpoint-selection-pending");
    }
    return undefined;
  }
  const selection = selector(active);
  assertFileJournalFence(root, selection);
  const value = readRegular(join(directory, `checkpoint-${selection.id}.json`));
  const receipt = { digest: selection.digest, head: selection.head };
  const checkpoint = verifyCompactionCheckpoint(value, receipt);
  return {
    checkpoint: { receipt, value: checkpoint },
    journal: openFileJournal(join(directory, `tail-${selection.id}`), {
      head: checkpoint.head,
      keys: new Set(checkpoint.entries.map(({ event }) => event.key)),
    }),
  };
}
