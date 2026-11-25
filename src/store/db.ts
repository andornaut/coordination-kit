// The coordination store: one SQLite file with an append-only, hash-chained `events` table and
// projections updated in the same transaction. Every write is one short `BEGIN IMMEDIATE`
// transaction; projections can be dropped and rebuilt from the events at any time.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { Clock } from "../core/clock.ts";
import { systemGit } from "../core/git.ts";
import type { Layout } from "../core/layout.ts";
import { stateRoot } from "../core/stateRoot.ts";
import { canonicalJson, eventHash, rowEvent, sha256 } from "./eventCodec.ts";
import type { FileProjection } from "./fileProjection.ts";
import { fileAuthority } from "./files/authority.ts";
import {
  type CompactionCheckpoint,
  verifyCompactionCheckpoint,
} from "./files/compactionCheckpoint.ts";
import { fileLayoutProjection } from "./files/runtime.ts";
import { PROJECTIONS, RETIRED_TABLES } from "./projections.ts";
import {
  type Actor,
  type EventInput,
  GENESIS,
  type JsonObject,
  type Projection,
  STORE_SCHEMA,
  type StoredEvent,
  StoreError,
} from "./types.ts";

export const STORE_FILE = "coordination.db";
/** An in-memory store: nothing touches the filesystem. A dry run with no store file uses it. */
export const MEMORY = ":memory:";
const BUSY_TIMEOUT_MS = 5000;

/**
 * The store's directory: the configured state root, else the coordinator's `var/`. The wake files
 * live beside it under `wake/`.
 */
export function storeRoot(layout: Layout): string {
  return stateRoot(layout);
}

export function storePath(layout: Layout): string {
  return join(storeRoot(layout), STORE_FILE);
}

const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  actor_role TEXT,
  actor_native_id TEXT,
  actor_worker TEXT,
  at TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;

type Row = Record<string, SQLInputValue>;

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/**
 * A store written before a projection existed gets its tables on open, filled from the events the
 * projection reads, in one transaction. The events and their hashes are untouched.
 */
function addMissingProjections(db: DatabaseSync): void {
  const missing = (): Projection[] =>
    PROJECTIONS.filter((projection) => projection.tables.some((table) => !tableExists(db, table)));
  if (missing().length === 0) {
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    // Checked again under the write lock: another process may have added them meanwhile.
    for (const projection of missing()) {
      db.exec(projection.ddl);
      const kinds = Object.keys(projection.apply);
      const rows = db
        .prepare(
          `SELECT * FROM events WHERE kind IN (${kinds.map(() => "?").join(",")}) ORDER BY seq`,
        )
        .all(...kinds) as Row[];
      for (const row of rows) {
        const event = rowEvent(row);
        projection.apply[event.kind]?.(db, event);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface AppendResult {
  readonly event: StoredEvent;
  /** True when an event with this idempotency key already existed; nothing was written. */
  readonly duplicate: boolean;
}

export interface VerifyResult {
  readonly events: number;
  readonly head: { readonly seq: number; readonly hash: string };
}

/** What opening a layout's store reads: the clock for event times and the environment for Git. */
export interface StoreContext {
  readonly clock: Clock;
  readonly env: NodeJS.ProcessEnv;
}

/** The clock of a store that never times an event: reading it refuses `store-read-only`. */
export const READ_ONLY_CLOCK: Clock = () => {
  throw new StoreError("store-read-only");
};

/**
 * One open connection. Library callers trust their `Actor`: the CLI applies the registry fence
 * (see `resolveCaller`) before it calls a writer here.
 */
export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly #clock: Clock;
  readonly #files: FileProjection | undefined;
  readonly #checkpointHead: CompactionCheckpoint["head"] | undefined;
  readonly #reducedDigests = new Map<number, string>();
  #depth = 0;

  private constructor(
    clock: Clock,
    path: string,
    db: DatabaseSync,
    files?: FileProjection,
    checkpoint?: CompactionCheckpoint,
  ) {
    this.path = path;
    this.db = db;
    this.#clock = clock;
    this.#files = files;
    this.#checkpointHead = checkpoint?.head;
    for (const { event, reducedDigest } of checkpoint?.entries ?? []) {
      if (reducedDigest !== undefined) {
        this.#reducedDigests.set(event.seq, reducedDigest);
      }
    }
  }

  /**
   * Open or create the store at `path` with WAL, synchronous=FULL and foreign keys. `clock` times
   * the events it appends.
   */
  static open(clock: Clock, path: string): Store {
    const memory = path === MEMORY;
    const created = !memory && !existsSync(path);
    if (!memory) {
      mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    }
    const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
    try {
      if (created) {
        chmodSync(path, 0o600);
      }
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA foreign_keys = ON");
      const version = Number(
        (db.prepare("PRAGMA user_version").get() as Row | undefined)?.user_version ?? 0,
      );
      if (version > STORE_SCHEMA) {
        throw new StoreError("store-schema-newer");
      }
      if (version < STORE_SCHEMA) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(EVENTS_DDL);
          for (const projection of PROJECTIONS) {
            db.exec(projection.ddl);
          }
          db.exec(`PRAGMA user_version = ${STORE_SCHEMA}`);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } else {
        addMissingProjections(db);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    return new Store(clock, path, db);
  }

  /** Open or create the layout's selected authority. */
  static forLayout(
    context: StoreContext,
    layout: Layout,
    options: { readonly createMissing?: boolean } = {},
  ): Store {
    const selected = fileAuthority(systemGit(context.env), layout, storePath(layout));
    if (selected.kind === "files") {
      return Store.#openSelectedFiles(context.clock, layout, selected);
    }
    const path = selected.path;
    return Store.open(
      context.clock,
      options.createMissing === false && !existsSync(path) ? MEMORY : path,
    );
  }

  /**
   * Open an existing authority for queries without creating or repairing its disk state. Its clock
   * is `READ_ONLY_CLOCK`.
   */
  static readLayout(context: Pick<StoreContext, "env">, layout: Layout): Store | null {
    const selected = fileAuthority(systemGit(context.env), layout, storePath(layout));
    const path = selected.path;
    if (selected.kind === "files") {
      const store = Store.#openSelectedFiles(READ_ONLY_CLOCK, layout, selected);
      store.db.exec("PRAGMA query_only = ON");
      return store;
    }
    return existsSync(path)
      ? new Store(
          READ_ONLY_CLOCK,
          path,
          new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS }),
        )
      : null;
  }

  static #openSelectedFiles(
    clock: Clock,
    layout: Layout,
    selected: Extract<ReturnType<typeof fileAuthority>, { kind: "files" }>,
  ): Store {
    const { path, receipt } = selected;
    const store = Store.openFileProjection(clock, path, fileLayoutProjection(layout, path));
    const { hash, seq } = receipt.head;
    try {
      if (
        seq !== 0 &&
        store.db.prepare("SELECT hash FROM events WHERE seq = ?").get(seq)?.hash !== hash
      ) {
        throw new StoreError("migration-file-origin-mismatch");
      }
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  /** Rebuild the compatibility query index from the authoritative committed file events. */
  static openFileProjection(clock: Clock, path: string, files: FileProjection): Store {
    const proof = files.checkpoint;
    const checkpoint = proof && verifyCompactionCheckpoint(proof.value, proof.receipt);
    const index = Store.open(clock, MEMORY);
    const store = new Store(clock, path, index.db, files, checkpoint);
    try {
      if (checkpoint !== undefined) {
        store.#replay(
          checkpoint.entries.map(({ event }) => event),
          true,
        );
        store.#verifyCheckpointHead();
      }
      store.#replay(files.journal.events(checkpoint?.head.seq));
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  get fileBacked(): boolean {
    return this.#files !== undefined;
  }

  compactedEventSequences(): ReadonlySet<number> {
    return new Set(this.#reducedDigests.keys());
  }

  close(): void {
    this.db.close();
  }

  /** The store clock's instant in `toISOString` form. */
  now(): string {
    return this.#clock().toISOString();
  }

  /** Run `body` in one `BEGIN IMMEDIATE` transaction; nested calls join the outer one. */
  transaction<T>(body: () => T): T {
    if (this.#depth > 0) {
      return body();
    }
    const files = this.#files;
    if (files === undefined) {
      return this.#transaction(body);
    }
    return files.journal.withWriter((writer) => {
      this.#replay(writer.events(this.head().seq));
      const before = this.head().seq;
      return this.#transaction(() => {
        const result = body();
        if (result instanceof Promise) {
          throw new StoreError("async-store-transaction");
        }
        const events = this.events({ afterSeq: before });
        if (events.length > 0) {
          writer.commit(events, files.records(this.db, before, events));
        }
        return result;
      });
    });
  }

  #transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    this.#depth++;
    try {
      const value = body();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    } finally {
      this.#depth--;
    }
  }

  #verifyCheckpointHead(): void {
    const head = this.#checkpointHead;
    if (
      head !== undefined &&
      head.seq > 0 &&
      this.db.prepare("SELECT hash FROM events WHERE seq = ?").get(head.seq)?.hash !== head.hash
    ) {
      throw new StoreError("checkpoint-proof-mismatch");
    }
  }

  #authentic(event: StoredEvent, allowReduced: boolean): boolean {
    const reducedDigest = allowReduced ? this.#reducedDigests.get(event.seq) : undefined;
    if (reducedDigest !== undefined) {
      return sha256(canonicalJson(event)) === reducedDigest;
    }
    return eventHash(event) === event.hash;
  }

  #replay(events: readonly StoredEvent[], allowReduced = false): void {
    if (events.length === 0) {
      return;
    }
    this.#transaction(() => {
      let { hash: prevHash, seq } = this.head();
      for (const event of events) {
        if (
          event.seq !== seq + 1 ||
          event.prevHash !== prevHash ||
          !this.#authentic(event, allowReduced)
        ) {
          throw new StoreError("chain-broken", `at seq ${event.seq}`);
        }
        this.#insert(event);
        seq = event.seq;
        prevHash = event.hash;
      }
    });
  }

  head(): { readonly seq: number; readonly hash: string } {
    const row = this.db.prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1").get() as
      Row | undefined;
    return row === undefined
      ? { hash: GENESIS, seq: 0 }
      : { hash: row.hash as string, seq: Number(row.seq) };
  }

  eventByKey(key: string): StoredEvent | undefined {
    const row = this.db.prepare("SELECT * FROM events WHERE key = ?").get(key) as Row | undefined;
    return row === undefined ? undefined : rowEvent(row);
  }

  /**
   * Append one event and apply its projections, in the caller's transaction or a new one. An
   * existing idempotency key returns the stored event unchanged with `duplicate: true`.
   */
  append(input: EventInput): AppendResult {
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(input.kind) || input.key === "") {
      throw new StoreError("invalid-event");
    }
    return this.transaction(() => {
      const existing = this.eventByKey(input.key);
      if (existing !== undefined) {
        return { duplicate: true, event: existing };
      }
      const head = this.head();
      const payload = JSON.parse(canonicalJson(input.payload)) as JsonObject;
      const actor: Actor = {
        nativeId: input.actor.nativeId,
        role: input.actor.role,
        ...(input.actor.worker === undefined ? {} : { worker: input.actor.worker }),
      };
      const draft = {
        actor,
        at: input.at ?? this.now(),
        key: input.key,
        kind: input.kind,
        payload,
        prevHash: head.hash,
        seq: head.seq + 1,
      };
      const event: StoredEvent = { ...draft, hash: eventHash(draft) };
      this.#insert(event);
      return { duplicate: false, event };
    });
  }

  #insert(event: StoredEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (seq, key, kind, actor_role, actor_native_id, actor_worker, at,
           payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.seq,
        event.key,
        event.kind,
        event.actor.role,
        event.actor.nativeId,
        event.actor.worker ?? null,
        event.at,
        canonicalJson(event.payload),
        event.prevHash,
        event.hash,
      );
    this.project(event);
  }

  private project(event: StoredEvent): void {
    let projected = event;
    if (this.#reducedDigests.has(event.seq)) {
      if (event.kind === "session.started") {
        // The qualified window preserves subsequent starts for the same role.
        return;
      }
      if (event.kind === "msg.sent" || event.kind === "msg.imported") {
        // The query index requires text. Exact body reads inspect the original event payload.
        projected = { ...event, payload: { ...event.payload, body: "" } };
      }
    }
    for (const projection of PROJECTIONS) {
      projection.apply[projected.kind]?.(this.db, projected);
    }
  }

  /** Events in seq order after `afterSeq`, optionally of the given kinds. */
  events(
    options: { readonly afterSeq?: number; readonly kinds?: readonly string[] } = {},
  ): StoredEvent[] {
    const kinds = options.kinds ?? [];
    const filter = kinds.length === 0 ? "" : ` AND kind IN (${kinds.map(() => "?").join(",")})`;
    return (
      this.db
        .prepare(`SELECT * FROM events WHERE seq > ?${filter} ORDER BY seq`)
        .all(options.afterSeq ?? 0, ...kinds) as Row[]
    ).map(rowEvent);
  }

  /** Recompute every link of the chain; throws `chain-broken` at the first mismatch. */
  verify(): VerifyResult {
    this.#verifyCheckpointHead();
    let prev = GENESIS;
    let seq = 0;
    for (const row of this.db
      .prepare("SELECT * FROM events ORDER BY seq")
      .iterate() as Iterable<Row>) {
      const event = rowEvent(row);
      if (
        event.seq !== seq + 1 ||
        event.prevHash !== prev ||
        !this.#authentic(event, true) ||
        canonicalJson(event.payload) !== row.payload
      ) {
        throw new StoreError("chain-broken", `at seq ${event.seq}`);
      }
      prev = event.hash;
      seq = event.seq;
    }
    return { events: seq, head: { hash: prev, seq } };
  }

  /** Verify the chain, then drop and recreate every projection from the same transaction. */
  rebuild(): VerifyResult {
    return this.transaction(() => {
      const verified = this.verify();
      for (const table of RETIRED_TABLES) {
        this.db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      for (const projection of PROJECTIONS) {
        for (const table of projection.tables) {
          this.db.exec(`DROP TABLE IF EXISTS ${table}`);
        }
        this.db.exec(projection.ddl);
      }
      for (const row of this.db.prepare("SELECT * FROM events ORDER BY seq").all() as Row[]) {
        this.project(rowEvent(row));
      }
      return verified;
    });
  }
}
