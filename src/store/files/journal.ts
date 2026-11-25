import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { fsyncDirectory, tempPrefix, writeDurable } from "../../core/durable.ts";
import { isCanonicalUuid } from "../../core/ids.ts";
import { holdLock, LockBusy } from "../../core/lock.ts";
import { isRecord } from "../../core/pyjson.ts";
import { canonicalJson, eventHash, sha256 } from "../eventCodec.ts";
import { ensure, GENESIS, type Json, type StoredEvent, StoreError } from "../types.ts";

export interface FileRecord {
  readonly path: string;
  readonly data: Json;
}

export interface JournalWriter {
  events(afterSeq?: number): StoredEvent[];
  commit(events: readonly StoredEvent[], records?: readonly FileRecord[]): void;
}

export interface FileJournal {
  events(afterSeq?: number): StoredEvent[];
  snapshot(): { readonly events: readonly StoredEvent[]; readonly records: readonly Companion[] };
  withWriter<T>(run: (writer: JournalWriter) => T): T;
}

interface Companion {
  readonly path: string;
  readonly sha256: string;
}

interface Batch {
  readonly schema: 1;
  readonly events: readonly StoredEvent[];
  readonly records: readonly Companion[];
}

interface Paths {
  readonly root: string;
  readonly journal: string;
  readonly batches: string;
  readonly keys: string;
  readonly lock: string;
  readonly prepare: string;
  readonly stage: string;
  readonly baseline: JournalBaseline;
}

interface Head {
  readonly hash: string;
  readonly seq: number;
}

export interface JournalBaseline {
  readonly head: Head;
  readonly keys: ReadonlySet<string>;
}

const ROOTS = new Set(["roles", "coordinator", "legacy"]);
const SAFE_SEGMENT = /^(?:[A-Za-z0-9_~.-]|%[0-9A-F]{2})+$/;
const BATCH_FILE = /^\d{16}\.json$/;
const HEX = /^[a-f0-9]{64}$/;
const CHECKPOINT_FENCE = "checkpoint-fence.json";
const RESERVATION = "compaction-reservation.json";
const EMPTY_BASELINE: JournalBaseline = { head: { hash: GENESIS, seq: 0 }, keys: new Set() };
const WRITE_TIMEOUT_SECONDS = 5;

function json(value: unknown): string {
  return `${canonicalJson(value)}\n`;
}

function safeRecordPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 4095) {
    return false;
  }
  const segments = path.split("/");
  const namespace = segments[0]!;
  return (
    ROOTS.has(namespace) &&
    segments.length >= (namespace === "roles" ? 3 : 2) &&
    segments.every(
      (segment) => segment.length <= 240 && !segment.startsWith(".") && SAFE_SEGMENT.test(segment),
    )
  );
}

function seqName(seq: number): string {
  return `${String(seq).padStart(16, "0")}.json`;
}

function keyPath(event: StoredEvent): string {
  return `journal/keys/${sha256(event.key)}.json`;
}

function keyBytes(first: number, event: StoredEvent): string {
  return json({ batch: first, hash: event.hash, seq: event.seq });
}

function paths(root: string, baseline: JournalBaseline): Paths {
  const journal = join(root, "journal");
  return {
    baseline,
    batches: join(journal, "batches"),
    journal,
    keys: join(journal, "keys"),
    lock: join(journal, "writer.lock"),
    prepare: join(journal, ".prepare.json"),
    root,
    stage: join(journal, ".record.tmp"),
  };
}

function isDirectory(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) {
    return false;
  }
  ensure(entry.isDirectory(), "journal-path-conflict");
  return true;
}

function ensureDirectory(path: string): void {
  if (isDirectory(path)) {
    return;
  }
  const parent = dirname(path);
  ensureDirectory(parent);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !isDirectory(path)) {
      throw error;
    }
  }
  fsyncDirectory(parent);
}

function scopedDirectory(root: string, path: string, create = false): boolean {
  if (!isDirectory(root)) {
    return false;
  }
  let current = root;
  for (const part of relative(root, path).split("/").filter(Boolean)) {
    current = join(current, part);
    if (create) {
      ensureDirectory(current);
    } else if (!isDirectory(current)) {
      return false;
    }
  }
  return true;
}

function readFile(file: string): Buffer | undefined {
  return isFile(file) ? readFileSync(file) : undefined;
}

function readRecord(paths: Paths, path: string): Buffer | undefined {
  const file = join(paths.root, path);
  return scopedDirectory(paths.root, dirname(file)) ? readFile(file) : undefined;
}

function isFile(path: string): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  if (info === undefined) {
    return false;
  }
  ensure(info.isFile(), "journal-path-conflict");
  return true;
}

function removeFile(path: string): boolean {
  if (!isFile(path)) {
    return false;
  }
  unlinkSync(path);
  return true;
}

function nullableText(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isEvent(value: unknown): value is StoredEvent {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.seq) &&
    Number(value.seq) > 0 &&
    typeof value.key === "string" &&
    value.key !== "" &&
    typeof value.kind === "string" &&
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value.kind) &&
    typeof value.at === "string" &&
    typeof value.prevHash === "string" &&
    HEX.test(value.prevHash) &&
    typeof value.hash === "string" &&
    HEX.test(value.hash) &&
    isRecord(value.payload) &&
    isRecord(value.actor) &&
    nullableText(value.actor.role) &&
    nullableText(value.actor.nativeId) &&
    (value.actor.worker === undefined || typeof value.actor.worker === "string")
  );
}

function verifyEvents(events: readonly unknown[], initial: Head): StoredEvent[] {
  let head = initial;
  const verified: StoredEvent[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (
      !isEvent(event) ||
      event.seq !== head.seq + 1 ||
      event.prevHash !== head.hash ||
      eventHash(event) !== event.hash ||
      seen.has(event.key)
    ) {
      throw new StoreError("journal-chain-broken", `at seq ${head.seq + 1}`);
    }
    verified.push(event);
    head = event;
    seen.add(event.key);
  }
  return verified;
}

function parseBatch(bytes: Buffer, filename?: string): Batch {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new StoreError("journal-corrupt");
  }
  ensure(
    isRecord(value) &&
      value.schema === 1 &&
      Array.isArray(value.events) &&
      value.events.length > 0 &&
      Array.isArray(value.records) &&
      bytes.equals(Buffer.from(json(value))),
    "journal-corrupt",
  );
  const first: unknown = value.events[0];
  ensure(isEvent(first), "journal-corrupt");
  ensure(filename === undefined || filename === seqName(first.seq), "journal-corrupt");
  const events = verifyEvents(value.events, { hash: first.prevHash, seq: first.seq - 1 });
  const records: Companion[] = [];
  const seen = new Set<string>();
  for (const record of value.records as unknown[]) {
    ensure(
      isRecord(record) &&
        safeRecordPath(record.path) &&
        typeof record.sha256 === "string" &&
        HEX.test(record.sha256) &&
        !seen.has(record.path),
      "journal-corrupt",
    );
    records.push({ path: record.path, sha256: record.sha256 });
    seen.add(record.path);
  }
  return { events, records, schema: 1 };
}

function batchHead(paths: Paths, batch?: Batch): Head {
  return batch?.events.at(-1) ?? paths.baseline.head;
}

function batchFiles(paths: Paths, fenced = false): string[] {
  if (!scopedDirectory(paths.root, paths.batches)) {
    return [];
  }
  const names = readdirSync(paths.batches).filter((name) => !fenced || name !== CHECKPOINT_FENCE);
  ensure(
    names.every((name) => BATCH_FILE.test(name)),
    "journal-corrupt",
  );
  return names.sort();
}

function readBatch(paths: Paths, filename: string): Batch {
  const bytes = readFile(join(paths.batches, filename));
  ensure(bytes !== undefined, "journal-corrupt");
  return parseBatch(bytes, filename);
}

function batchCompanions(batch: Batch): Companion[] {
  return [
    ...batch.records,
    ...batch.events.map((event) => ({
      path: keyPath(event),
      sha256: sha256(keyBytes(batch.events[0]!.seq, event)),
    })),
  ];
}

function verifyCompanions(paths: Paths, batch: Batch): void {
  ensure(
    batch.events.every((event) => !paths.baseline.keys.has(event.key)),
    "journal-key-conflict",
  );
  for (const record of batchCompanions(batch)) {
    const bytes = readRecord(paths, record.path);
    ensure(bytes !== undefined && sha256(bytes) === record.sha256, "journal-record-mismatch");
  }
}

function firstFor(files: readonly string[], afterSeq: number): number {
  if (afterSeq === 0) {
    return 0;
  }
  const following = files.findIndex((name) => Number(name.slice(0, 16)) > afterSeq);
  return Math.max(0, (following === -1 ? files.length : following) - 1);
}

function readEvents(paths: Paths, files: readonly string[], afterSeq: number): StoredEvent[] {
  ensure(Number.isSafeInteger(afterSeq) && afterSeq >= 0, "journal-invalid-cursor");
  if (files.length === 0) {
    return [];
  }
  const start = firstFor(files, afterSeq);
  let head = batchHead(paths, start === 0 ? undefined : readBatch(paths, files[start - 1]!));
  const events: StoredEvent[] = [];
  for (const filename of files.slice(start)) {
    const batch = readBatch(paths, filename);
    const first = batch.events[0]!;
    ensure(first.seq === head.seq + 1 && first.prevHash === head.hash, "journal-chain-broken");
    verifyCompanions(paths, batch);
    for (const event of batch.events) {
      if (event.seq > afterSeq) {
        events.push(event);
      }
    }
    head = batchHead(paths, batch);
  }
  return events;
}

function writeRecord(paths: Paths, directories: Set<string>, path: string, bytes: string): void {
  const file = join(paths.root, path);
  const directory = dirname(file);
  scopedDirectory(paths.root, directory, true);
  const fd = openSync(
    paths.stage,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    writeFileSync(fd, bytes, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  linkSync(paths.stage, file);
  unlinkSync(paths.stage);
  for (let entry = directory; entry !== paths.root; entry = dirname(entry)) {
    directories.add(entry);
  }
}

interface PreparedBatch {
  readonly batch: Batch;
  readonly published: boolean;
}

function preparedBatch(paths: Paths): PreparedBatch | undefined {
  const intent = readFile(paths.prepare);
  if (intent === undefined) {
    return undefined;
  }
  const batch = parseBatch(intent);
  const filename = seqName(batch.events[0]!.seq);
  const published = scopedDirectory(paths.root, paths.batches)
    ? readFile(join(paths.batches, filename))
    : undefined;
  if (published !== undefined) {
    ensure(intent.equals(published), "journal-corrupt");
    // The writer may have exited between the manifest link and directory fsync.
    fsyncDirectory(paths.batches);
  }
  return { batch, published: published !== undefined };
}

function recover(paths: Paths): void {
  const pending = preparedBatch(paths);
  if (pending?.published === true) {
    verifyCompanions(paths, pending.batch);
  } else if (pending !== undefined) {
    const records = batchCompanions(pending.batch);
    // A mismatched file may be unrelated data. Verify ownership of every orphan before removing any.
    const orphans = records.filter((record) => {
      const bytes = readRecord(paths, record.path);
      ensure(bytes === undefined || sha256(bytes) === record.sha256, "journal-record-mismatch");
      return bytes !== undefined;
    });
    for (const { path } of orphans) {
      const file = join(paths.root, path);
      unlinkSync(file);
      fsyncDirectory(dirname(file));
    }
  }
  let changed = removeFile(paths.stage);
  if (pending !== undefined) {
    changed = removeFile(paths.prepare) || changed;
  }
  const prefix = tempPrefix(paths.prepare);
  for (const name of readdirSync(paths.journal)) {
    if (name.startsWith(prefix) && /^\d+\.[a-f0-9]{12}\.tmp$/.test(name.slice(prefix.length))) {
      changed = removeFile(join(paths.journal, name)) || changed;
    }
  }
  if (changed) {
    fsyncDirectory(paths.journal);
  }
}

function commitBatch(
  paths: Paths,
  files: string[],
  events: readonly StoredEvent[],
  records: readonly FileRecord[],
): void {
  if (events.length === 0) {
    ensure(records.length === 0, "journal-records-without-events");
    return;
  }
  const first = events[0]!;
  ensure(isEvent(first), "journal-invalid-event");
  const companions = new Map<string, string>();
  for (const { data, path } of records) {
    ensure(safeRecordPath(path), "journal-invalid-record-path");
    ensure(!companions.has(path), "journal-record-conflict");
    companions.set(path, json(data));
  }
  const batch: Batch = {
    events,
    records: [...companions.keys()].sort().map((path) => ({
      path,
      sha256: sha256(companions.get(path)!),
    })),
    schema: 1,
  };
  const manifest = json(batch);
  const filename = seqName(first.seq);
  if (files.includes(filename)) {
    const published = readFile(join(paths.batches, filename));
    ensure(
      published !== undefined && published.equals(Buffer.from(manifest)),
      "journal-replay-conflict",
    );
    verifyCompanions(paths, parseBatch(published, filename));
    return;
  }
  const previous = files.at(-1);
  const last = previous === undefined ? undefined : readBatch(paths, previous);
  if (last !== undefined) {
    const predecessor = files.at(-2);
    const anchor = batchHead(
      paths,
      predecessor === undefined ? undefined : readBatch(paths, predecessor),
    );
    const start = last.events[0]!;
    ensure(start.seq === anchor.seq + 1 && start.prevHash === anchor.hash, "journal-chain-broken");
    verifyCompanions(paths, last);
  }
  verifyEvents(events, batchHead(paths, last));
  for (const path of companions.keys()) {
    ensure(readRecord(paths, path) === undefined, "journal-record-conflict");
  }
  for (const event of events) {
    const path = keyPath(event);
    ensure(
      !paths.baseline.keys.has(event.key) && readRecord(paths, path) === undefined,
      "journal-key-conflict",
    );
    companions.set(path, keyBytes(first.seq, event));
  }
  try {
    // The durable intent owns every possible orphan before any companion is linked in place.
    writeDurable(paths.prepare, manifest);
    const directories = new Set([paths.root]);
    for (const [path, bytes] of companions) {
      writeRecord(paths, directories, path, bytes);
    }
    for (const directory of directories) {
      fsyncDirectory(directory);
    }
    fsyncDirectory(dirname(paths.root));
    // Publication is an exclusive link. Readers wait for the directory fsync under this lock.
    linkSync(paths.prepare, join(paths.batches, filename));
    fsyncDirectory(paths.batches);
    unlinkSync(paths.prepare);
    fsyncDirectory(paths.journal);
  } catch (error) {
    recover(paths);
    throw error;
  }
  files.push(filename);
}

function locked<T>(paths: Paths, shared: boolean, run: () => T): T {
  let lock;
  isFile(paths.lock);
  try {
    lock = holdLock(paths.lock, {
      readOnly: shared,
      shared,
      timeoutSeconds: WRITE_TIMEOUT_SECONDS,
    });
  } catch (error) {
    if (error instanceof LockBusy) {
      throw new StoreError("journal-busy");
    }
    throw error;
  }
  try {
    return run();
  } finally {
    lock.release();
  }
}

export interface FileJournalReservationRequest {
  readonly head: Head;
  readonly id: string;
  readonly registryRevision: number;
}

export interface FileJournalReservation extends FileJournalReservationRequest {
  readonly nonce: string;
}

function validReservationRequest(value: unknown): value is FileJournalReservationRequest {
  return (
    isRecord(value) &&
    isCanonicalUuid(value.id) &&
    typeof value.registryRevision === "number" &&
    Number.isSafeInteger(value.registryRevision) &&
    value.registryRevision > 0 &&
    isRecord(value.head) &&
    Object.keys(value.head).sort().join(",") === "hash,seq" &&
    typeof value.head.hash === "string" &&
    HEX.test(value.head.hash) &&
    value.head.hash !== GENESIS &&
    typeof value.head.seq === "number" &&
    Number.isSafeInteger(value.head.seq) &&
    value.head.seq > 0
  );
}

function reservationBytes(reservation: FileJournalReservation): string {
  const { head, id, nonce, registryRevision } = reservation;
  return json({ head, id, nonce, registryRevision, schema: 1 });
}

export function readFileJournalReservation(root: string): FileJournalReservation | undefined {
  const file = join(root, RESERVATION);
  const stats = lstatSync(file, { throwIfNoEntry: false });
  if (stats === undefined) {
    return undefined;
  }
  ensure(stats.isFile() && stats.nlink === 1, "compaction-reservation-invalid");
  const bytes = readFileSync(file, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(bytes) as unknown;
  } catch {
    throw new StoreError("compaction-reservation-invalid");
  }
  ensure(
    isRecord(value) && isCanonicalUuid(value.nonce) && validReservationRequest(value),
    "compaction-reservation-invalid",
  );
  const reservation = {
    head: value.head,
    id: value.id,
    nonce: value.nonce,
    registryRevision: value.registryRevision,
  };
  ensure(bytes === reservationBytes(reservation), "compaction-reservation-invalid");
  return reservation;
}

export function assertFileJournalReservation(
  root: string,
  expected?: FileJournalReservation,
): void {
  const found = readFileJournalReservation(root);
  if (expected === undefined) {
    ensure(found === undefined, "compaction-reserved");
  } else {
    ensure(found !== undefined, "compaction-reservation-required");
    ensure(
      reservationBytes(found) === reservationBytes(expected),
      "compaction-reservation-mismatch",
    );
  }
}

function withExistingWriter<T>(
  root: string,
  baseline: JournalBaseline,
  run: (journal: Paths) => T,
  initializeTail = false,
): T {
  const journal = paths(resolve(root), baseline);
  if (initializeTail && baseline.head.seq > 0) {
    ensureDirectory(journal.root);
    scopedDirectory(journal.root, journal.journal, true);
    return locked(journal, false, () => {
      scopedDirectory(journal.root, journal.batches, true);
      return run(journal);
    });
  }
  ensure(
    scopedDirectory(journal.root, journal.batches) && isFile(journal.lock),
    "checkpoint-source-unavailable",
  );
  return locked(journal, false, () => run(journal));
}

function snapshot(paths: Paths, files: readonly string[]): ReturnType<FileJournal["snapshot"]> {
  return {
    events: readEvents(paths, files, 0),
    records: files.flatMap((filename) => readBatch(paths, filename).records),
  };
}

export function reserveFileJournal(
  root: string,
  request: FileJournalReservationRequest,
  baseline: JournalBaseline = EMPTY_BASELINE,
): FileJournalReservation {
  ensure(validReservationRequest(request), "compaction-reservation-invalid");
  // A selected tail can be empty. Acquire its usual writer lock before checking the head.
  return withExistingWriter(
    root,
    baseline,
    (journal) => {
      ensure(readFileJournalFence(journal.root) === undefined, "compaction-source-already-fenced");
      const current = readFileJournalReservation(journal.root);
      const reservation = { ...request, nonce: current?.nonce ?? randomUUID() };
      if (current !== undefined) {
        assertFileJournalReservation(journal.root, reservation);
      } else {
        recover(journal);
      }
      const head = readEvents(journal, batchFiles(journal), 0).at(-1) ?? baseline.head;
      ensure(
        head.seq === reservation.head.seq && head.hash === reservation.head.hash,
        "checkpoint-source-head-changed",
      );
      if (current === undefined) {
        writeDurable(join(journal.root, RESERVATION), reservationBytes(reservation));
      }
      return reservation;
    },
    true,
  );
}

export function cancelFileJournalReservation(
  root: string,
  reservation: FileJournalReservation,
  baseline: JournalBaseline = EMPTY_BASELINE,
): void {
  ensure(
    validReservationRequest(reservation) && isCanonicalUuid(reservation.nonce),
    "compaction-reservation-invalid",
  );
  withExistingWriter(root, baseline, (journal) => {
    ensure(readFileJournalFence(journal.root) === undefined, "compaction-source-already-fenced");
    assertFileJournalReservation(journal.root, reservation);
    unlinkSync(join(journal.root, RESERVATION));
    fsyncDirectory(journal.root);
  });
}

interface CheckpointFence {
  readonly digest: string;
  readonly head: Head;
  readonly id: string;
}

function fenceBytes(fence: CheckpointFence): Buffer {
  return Buffer.from(json({ ...fence, schema: 2 }));
}

/** An active checkpoint is valid only with this exact old-writer fence. */
export function assertFileJournalFence(root: string, fence: CheckpointFence): void {
  ensure(readFileJournalFence(root)?.equals(fenceBytes(fence)), "checkpoint-fence-mismatch");
}

export function readFileJournalFence(root: string): Buffer | undefined {
  const journal = paths(resolve(root), EMPTY_BASELINE);
  return scopedDirectory(journal.root, journal.batches)
    ? readFile(join(journal.batches, CHECKPOINT_FENCE))
    : undefined;
}

/** Read a retired journal only for qualification, against its exact committed fence. */
export function retiredFileJournalSnapshot(
  root: string,
  fence: CheckpointFence,
  baseline: JournalBaseline = EMPTY_BASELINE,
): ReturnType<FileJournal["snapshot"]> {
  const journal = paths(resolve(root), baseline);
  ensure(isFile(journal.lock), "checkpoint-source-unavailable");
  return locked(journal, true, () => {
    assertFileJournalFence(journal.root, fence);
    const source = snapshot(journal, batchFiles(journal, true));
    const head = source.events.at(-1) ?? baseline.head;
    ensure(
      head.seq === fence.head.seq && head.hash === fence.head.hash,
      "checkpoint-source-head-changed",
    );
    return source;
  });
}

/** Fence the old journal, including preopened writers, while selecting an exact verified candidate. */
export function fenceFileJournal<T>(
  root: string,
  fence: CheckpointFence,
  verifySource: (snapshot: ReturnType<FileJournal["snapshot"]>) => void,
  select: () => T,
  reservation?: FileJournalReservation,
  baseline: JournalBaseline = EMPTY_BASELINE,
): T {
  ensure(
    isCanonicalUuid(fence.id) &&
      HEX.test(fence.digest) &&
      HEX.test(fence.head.hash) &&
      Number.isSafeInteger(fence.head.seq) &&
      fence.head.seq > 0,
    "checkpoint-fence-invalid",
  );
  if (reservation !== undefined) {
    ensure(
      validReservationRequest(reservation) &&
        isCanonicalUuid(reservation.nonce) &&
        reservation.head.seq === fence.head.seq &&
        reservation.head.hash === fence.head.hash,
      "compaction-reservation-mismatch",
    );
  }
  return withExistingWriter(root, baseline, (journal) => {
    const file = join(journal.batches, CHECKPOINT_FENCE);
    const original = readFile(file);
    const expected = fenceBytes(fence);
    ensure(original === undefined || original.equals(expected), "checkpoint-fence-mismatch");
    const reserved = readFileJournalReservation(journal.root);
    if (original === undefined || reserved !== undefined) {
      assertFileJournalReservation(journal.root, reservation);
    }
    recover(journal);
    const source = snapshot(journal, batchFiles(journal, original !== undefined));
    const head = source.events.at(-1) ?? baseline.head;
    ensure(
      head.seq === fence.head.seq && head.hash === fence.head.hash,
      "checkpoint-source-head-changed",
    );
    const verified: unknown = verifySource(source);
    ensure(!(verified instanceof Promise), "checkpoint-verification-async");
    if (original === undefined) {
      const intent = join(journal.journal, CHECKPOINT_FENCE);
      writeDurable(intent, expected);
      linkSync(intent, file);
    }
    fsyncDirectory(journal.batches);
    const result = select();
    ensure(!(result instanceof Promise), "checkpoint-selection-async");
    if (reserved !== undefined) {
      unlinkSync(join(journal.root, RESERVATION));
      fsyncDirectory(journal.root);
    }
    return result;
  });
}

/** Open an append-only journal. Only a committed manifest makes its companion paths authoritative. */
export function openFileJournal(
  root: string,
  baseline: JournalBaseline = EMPTY_BASELINE,
): FileJournal {
  const { hash, seq } = baseline.head;
  ensure(
    Number.isSafeInteger(seq) && seq >= 0 && HEX.test(hash) && (seq === 0) === (hash === GENESIS),
    "journal-baseline-invalid",
  );
  const journal = paths(resolve(root), { head: { hash, seq }, keys: new Set(baseline.keys) });
  function read<T>(inspect: (files: readonly string[]) => T): T {
    if (!scopedDirectory(journal.root, journal.journal)) {
      return inspect([]);
    }
    if (!isFile(journal.lock)) {
      const hasState = batchFiles(journal).length > 0 || isFile(journal.prepare);
      // Initialization may have started between the first lock inspection and this read.
      if (!isFile(journal.lock)) {
        ensure(!hasState, "journal-corrupt");
        return inspect([]);
      }
    }
    return locked(journal, true, () => {
      preparedBatch(journal);
      return inspect(batchFiles(journal));
    });
  }
  return {
    events(afterSeq = 0) {
      return read((files) => readEvents(journal, files, afterSeq));
    },
    snapshot() {
      return read((files) => snapshot(journal, files));
    },
    withWriter<T>(run: (writer: JournalWriter) => T): T {
      ensureDirectory(journal.root);
      scopedDirectory(journal.root, journal.journal, true);
      return locked(journal, false, () => {
        assertFileJournalReservation(journal.root);
        scopedDirectory(journal.root, journal.batches, true);
        scopedDirectory(journal.root, journal.keys, true);
        recover(journal);
        const files = batchFiles(journal);
        let active = true;
        try {
          const result = run({
            commit(events, records = []) {
              ensure(active, "journal-writer-closed");
              commitBatch(journal, files, events, records);
            },
            events(afterSeq = 0) {
              ensure(active, "journal-writer-closed");
              return readEvents(journal, files, afterSeq);
            },
          });
          ensure(!(result instanceof Promise), "journal-async-writer");
          return result;
        } finally {
          active = false;
        }
      });
    },
  };
}
