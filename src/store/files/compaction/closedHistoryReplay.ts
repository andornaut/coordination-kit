import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";

import { MEMORY, READ_ONLY_CLOCK, Store } from "../../db.ts";
import { canonicalJson } from "../../eventCodec.ts";
import type { FileProjection } from "../../fileProjection.ts";
import { messageStatus } from "../../messages/messages.ts";
import { PROJECTIONS } from "../../projections.ts";
import { ensure, type StoredEvent, StoreError } from "../../types.ts";
import type { CheckpointHead, CheckpointReceipt, CompactionCheckpoint } from "./checkpoint.ts";
import type { FileCheckpointSource } from "./generation.ts";

const MISMATCH = "closed-history-replay-mismatch";
const TABLES = [...new Set(PROJECTIONS.flatMap(({ tables }) => tables))].sort();

interface ProjectionDigest {
  readonly rows: number;
  readonly sha256: string;
}

interface ClosedHistoryReplayProof {
  readonly stateEquivalent: true;
  readonly head: CheckpointHead;
  readonly events: number;
  readonly projections: Readonly<Record<string, ProjectionDigest>>;
  readonly removedBodies: number;
  readonly removedBodyBytes: number;
}

function replay(tail: readonly StoredEvent[], checkpoint?: FileProjection["checkpoint"]): Store {
  return Store.openFileProjection(READ_ONLY_CLOCK, MEMORY, {
    ...(checkpoint === undefined ? {} : { checkpoint }),
    journal: {
      events: (afterSeq = 0) => tail.filter(({ seq }) => seq > afterSeq),
      withWriter: () => {
        throw new StoreError("store-read-only");
      },
    },
    records: () => [],
  });
}

/** Verify the exact event envelopes and every prior reduction marker. */
function removedBodyBytes(
  source: FileCheckpointSource,
  checkpoint: CompactionCheckpoint,
  selected: ReadonlySet<string>,
): number {
  const prefix = source.previous?.checkpoint.entries ?? [];
  const tail = source.tail.events;
  ensure(checkpoint.entries.length === prefix.length + tail.length, MISMATCH);
  const removed = new Set<string>();
  let bytes = 0;
  for (const [index, entry] of checkpoint.entries.entries()) {
    const prior = prefix[index] ?? { event: tail[index - prefix.length]! };
    const { event, reducedDigest } = prior;
    const id = event.payload.id;
    if (
      (event.kind === "msg.sent" || event.kind === "msg.imported") &&
      typeof id === "string" &&
      selected.has(id)
    ) {
      const { body, ...payload } = event.payload;
      ensure(
        typeof body === "string" &&
          reducedDigest === undefined &&
          entry.reducedDigest !== undefined &&
          !removed.has(id) &&
          canonicalJson(entry.event) === canonicalJson({ ...event, payload }),
        MISMATCH,
      );
      removed.add(id);
      bytes += Buffer.byteLength(body);
    } else {
      ensure(canonicalJson(prior) === canonicalJson(entry), MISMATCH);
    }
  }
  ensure(removed.size === selected.size, MISMATCH);
  return bytes;
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqliteValue(value: SQLOutputValue): unknown {
  if (typeof value === "bigint") {
    return { integer: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { bytes: Buffer.from(value).toString("base64") };
  }
  return value;
}

function projectionDigest(
  store: Store,
  name: string,
  selected: ReadonlySet<string>,
): ProjectionDigest {
  const table = quote(name);
  const columns = store.db.prepare(`PRAGMA table_xinfo(${table})`).all();
  ensure(columns.length > 0, MISMATCH);
  // For messages the first key is the unique ID, so later columns cannot reorder equal rows
  // when one of the compared bodies is hidden.
  const ordered = columns.map(({ name: column }) => `${quote(String(column))} COLLATE BINARY`);
  const statement = store.db.prepare(`SELECT * FROM ${table} ORDER BY ${ordered.join(", ")}`);
  statement.setReadBigInts(true);
  const hash = createHash("sha256").update(`${canonicalJson(columns)}\n`);
  let rows = 0;
  for (const row of statement.iterate()) {
    const hideBody = name === "messages" && typeof row.id === "string" && selected.has(row.id);
    const values = Object.values(hideBody ? { ...row, body: null } : row).map(sqliteValue);
    hash.update(`${canonicalJson(values)}\n`);
    rows += 1;
  }
  return { rows, sha256: hash.digest("hex") };
}

/** Qualify a restored source and a candidate without opening a filesystem journal or writing it. */
export function verifyClosedHistoryReplay(
  source: FileCheckpointSource,
  checkpoint: CompactionCheckpoint,
  receipt: CheckpointReceipt,
  selected: readonly string[],
): ClosedHistoryReplayProof {
  const ids = new Set(selected);
  ensure(ids.size === selected.length, MISMATCH);
  let before: Store | undefined;
  let after: Store | undefined;
  try {
    const prior = source.previous;
    before = replay(
      source.tail.events,
      prior === undefined ? undefined : { receipt: prior.selection, value: prior.checkpoint },
    );
    after = replay([], { receipt, value: checkpoint });
    const head = before.head();
    ensure(canonicalJson(head) === canonicalJson(after.head()), MISMATCH);
    const bytes = removedBodyBytes(source, checkpoint, ids);
    for (const id of ids) {
      const original = messageStatus(before, id, true);
      const compacted = messageStatus(after, id, true);
      ensure(
        typeof original.body === "string" &&
          (original.state === "handled" || original.state === "superseded") &&
          compacted.body === undefined &&
          compacted.bodyExpired === true,
        MISMATCH,
      );
    }
    const projections: Record<string, ProjectionDigest> = {};
    for (const name of TABLES) {
      const original = projectionDigest(before, name, ids);
      const compacted = projectionDigest(after, name, ids);
      ensure(original.rows === compacted.rows && original.sha256 === compacted.sha256, MISMATCH);
      projections[name] = original;
    }
    return {
      events: head.seq,
      head,
      projections,
      removedBodies: ids.size,
      removedBodyBytes: bytes,
      stateEquivalent: true,
    };
  } catch {
    // Replayed values and database details are private evidence.
    throw new StoreError(MISMATCH);
  } finally {
    after?.close();
    before?.close();
  }
}
