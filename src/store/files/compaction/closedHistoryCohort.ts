import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { isRecord } from "../../../core/encoding/pyjson.ts";
import { REF, sha256 } from "../../eventCodec.ts";
import { ensure, GENESIS, ROLE, type StoredEvent, StoreError } from "../../types.ts";
import type { CheckpointHead } from "./checkpoint.ts";

const HEX = /^[a-f0-9]{64}$/;
const WINDOW = 100;
const STATE = "requested-cohort-not-activation-evidence";
const INVALID = "closed-history-cohort-invalid";
const PATH_INVALID = "closed-history-cohort-path-invalid";
const BASELINE_MISMATCH = "closed-history-cohort-baseline-mismatch";
const ENTRY_MISMATCH = "closed-history-cohort-entry-mismatch";

interface CohortOriginal {
  readonly id: string;
  readonly owner: string;
  readonly originalSeq: number;
  readonly closeSeq: number;
  readonly disposition: "handled" | "superseded";
  readonly bodySha256: string;
}

export interface ClosedHistoryCohort {
  readonly schema: 1;
  readonly state: typeof STATE;
  readonly head: CheckpointHead;
  readonly registryRevision: number;
  readonly window: typeof WINDOW;
  readonly count: number;
  readonly originals: readonly CohortOriginal[];
  readonly sha256: string;
}

function exactKeys(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join(",") === keys;
}

function integer(value: unknown, minimum = 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function digest(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function cohortBytes(path: string): Buffer {
  try {
    ensure(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path, PATH_INVALID);
    const before = lstatSync(path);
    ensure(before.isFile() && before.nlink === 1, PATH_INVALID);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      ensure(
        opened.isFile() &&
          opened.nlink === 1 &&
          opened.dev === before.dev &&
          opened.ino === before.ino,
        PATH_INVALID,
      );
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new StoreError(PATH_INVALID);
  }
}

/** Read a request artifact bound to the approved raw bytes. It authorizes no activation. */
export function readClosedHistoryCohort(path: string, expectedSha256: string): ClosedHistoryCohort {
  ensure(digest(expectedSha256), INVALID);
  const bytes = cohortBytes(path);
  const actualSha256 = sha256(bytes);
  ensure(actualSha256 === expectedSha256, "closed-history-cohort-digest-mismatch");
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new StoreError(INVALID);
  }
  ensure(
    isRecord(value) &&
      exactKeys(value, "count,head,originals,registryRevision,schema,state,window") &&
      value.schema === 1 &&
      value.state === STATE &&
      isRecord(value.head) &&
      exactKeys(value.head, "hash,seq") &&
      integer(value.head.seq) &&
      digest(value.head.hash) &&
      integer(value.registryRevision) &&
      value.window === WINDOW &&
      integer(value.count, 0) &&
      Array.isArray(value.originals) &&
      value.originals.length === value.count,
    INVALID,
  );
  const head = { hash: value.head.hash, seq: value.head.seq };
  const originals: CohortOriginal[] = [];
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const entry of value.originals as unknown[]) {
    ensure(
      isRecord(entry) &&
        exactKeys(entry, "bodySha256,closeSeq,disposition,id,originalSeq,owner") &&
        typeof entry.id === "string" &&
        REF.test(entry.id) &&
        typeof entry.owner === "string" &&
        ROLE.test(entry.owner) &&
        integer(entry.originalSeq) &&
        integer(entry.closeSeq) &&
        entry.originalSeq < entry.closeSeq &&
        entry.closeSeq <= head.seq &&
        (entry.disposition === "handled" || entry.disposition === "superseded") &&
        digest(entry.bodySha256) &&
        !ids.has(entry.id) &&
        !sequences.has(entry.originalSeq) &&
        !sequences.has(entry.closeSeq),
      INVALID,
    );
    ids.add(entry.id);
    sequences.add(entry.originalSeq);
    sequences.add(entry.closeSeq);
    originals.push({
      bodySha256: entry.bodySha256,
      closeSeq: entry.closeSeq,
      disposition: entry.disposition,
      id: entry.id,
      originalSeq: entry.originalSeq,
      owner: entry.owner,
    });
  }
  return {
    count: value.count,
    head,
    originals,
    registryRevision: value.registryRevision,
    schema: 1,
    sha256: actualSha256,
    state: STATE,
    window: WINDOW,
  };
}

/** Verify exact original and terminal receipts on an already restored journal. */
export function verifyClosedHistoryCohort(
  cohort: ClosedHistoryCohort,
  events: readonly StoredEvent[],
  registryRevision: number,
): ReadonlySet<string> {
  ensure(
    integer(registryRevision) &&
      registryRevision >= cohort.registryRevision &&
      events[cohort.head.seq - 1]?.hash === cohort.head.hash,
    BASELINE_MISMATCH,
  );
  const originals = new Map(cohort.originals.map((entry) => [entry.id, entry]));
  let previous = GENESIS;
  for (const [index, event] of events.entries()) {
    ensure(
      event.seq === index + 1 && event.prevHash === previous && digest(event.hash),
      BASELINE_MISMATCH,
    );
    previous = event.hash;
    const id = event.payload.id;
    const entry = typeof id === "string" ? originals.get(id) : undefined;
    if (entry === undefined) {
      continue;
    }
    if (event.kind === "msg.sent" || event.kind === "msg.imported") {
      ensure(event.seq === entry.originalSeq, ENTRY_MISMATCH);
    } else if (event.kind === "msg.closed") {
      ensure(event.seq === entry.closeSeq, ENTRY_MISMATCH);
    }
  }
  for (const entry of cohort.originals) {
    const original = events[entry.originalSeq - 1];
    const close = events[entry.closeSeq - 1];
    const body = original?.payload.body;
    ensure(
      (original?.kind === "msg.sent" || original?.kind === "msg.imported") &&
        original.payload.id === entry.id &&
        original.payload.to === entry.owner &&
        original.payload.bodySha256 === entry.bodySha256 &&
        (body === undefined || (typeof body === "string" && sha256(body) === entry.bodySha256)) &&
        close?.kind === "msg.closed" &&
        close.payload.id === entry.id &&
        close.actor.role === entry.owner &&
        close.payload.state === entry.disposition,
      ENTRY_MISMATCH,
    );
  }
  return new Set(originals.keys());
}
