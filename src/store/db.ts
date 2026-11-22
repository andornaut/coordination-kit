// The coordination store: one SQLite file with an append-only, hash-chained `events` table and
// projections updated in the same transaction. Every write is one short `BEGIN IMMEDIATE`
// transaction; projections can be dropped and rebuilt from the events at any time.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { Layout } from "../layout.ts";
import { stateRoot } from "../stateRoot.ts";
import type { FileProjection } from "./fileProjection.ts";
import { type Projection, PROJECTIONS } from "./projections.ts";
import {
  type Actor,
  type EventInput,
  GENESIS,
  type Json,
  type JsonObject,
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

/** JSON with object keys sorted at every depth and no whitespace; the hash input form. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StoreError("invalid-payload");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new StoreError("invalid-payload");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 over the previous hash and the canonical event, so any edit breaks every later link. */
export function eventHash(event: Omit<StoredEvent, "hash">): string {
  return sha256(
    `${event.prevHash}\n${canonicalJson({
      actor: { nativeId: event.actor.nativeId, role: event.actor.role, worker: event.actor.worker },
      at: event.at,
      key: event.key,
      kind: event.kind,
      payload: event.payload,
      schema: STORE_SCHEMA,
      seq: event.seq,
    })}`,
  );
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

function rowEvent(row: Row): StoredEvent {
  const worker = row.actor_worker;
  return {
    actor: {
      nativeId: (row.actor_native_id as string | null) ?? null,
      role: (row.actor_role as string | null) ?? null,
      ...(typeof worker === "string" ? { worker } : {}),
    },
    at: row.at as string,
    hash: row.hash as string,
    key: row.key as string,
    kind: row.kind as string,
    payload: JSON.parse(row.payload as string) as JsonObject,
    prevHash: row.prev_hash as string,
    seq: Number(row.seq),
  };
}

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

export interface OpenOptions {
  /** Test hook: the clock for `at`. */
  readonly now?: () => string;
}

/**
 * One open connection. Library callers trust their `Actor`: the CLI applies the registry fence
 * (see `resolveCaller`) before it calls a writer here.
 */
export class Store {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly #now: () => string;
  readonly #files: FileProjection | undefined;
  #depth = 0;

  private constructor(
    path: string,
    db: DatabaseSync,
    options: OpenOptions,
    files?: FileProjection,
  ) {
    this.path = path;
    this.db = db;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#files = files;
  }

  /** Open or create the store at `path` with WAL, synchronous=FULL and foreign keys. */
  static open(path: string, options: OpenOptions = {}): Store {
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
    return new Store(path, db, options);
  }

  static forLayout(
    layout: Layout,
    options: OpenOptions & { readonly createMissing?: boolean } = {},
  ): Store {
    const path = storePath(layout);
    return Store.open(
      options.createMissing === false && !existsSync(path) ? MEMORY : path,
      options,
    );
  }

  /** Open an existing authority for queries without creating or repairing its disk state. */
  static readLayout(layout: Layout): Store | null {
    const path = storePath(layout);
    return existsSync(path)
      ? new Store(path, new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS }), {})
      : null;
  }

  /** Rebuild the compatibility query index from the authoritative committed file events. */
  static openFileProjection(path: string, files: FileProjection, options: OpenOptions = {}): Store {
    const index = Store.open(MEMORY);
    const store = new Store(path, index.db, options, files);
    try {
      store.#replay(files.journal.events());
      return store;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  now(): string {
    return this.#now();
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
          writer.commit(events, files.records(events));
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

  #replay(events: readonly StoredEvent[]): void {
    if (events.length === 0) {
      return;
    }
    this.#transaction(() => {
      let { seq, hash: prevHash } = this.head();
      for (const event of events) {
        const { hash, ...draft } = event;
        if (event.seq !== seq + 1 || event.prevHash !== prevHash || eventHash(draft) !== hash) {
          throw new StoreError("chain-broken", `at seq ${event.seq}`);
        }
        this.#insert(event);
        seq = event.seq;
        prevHash = hash;
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
    for (const projection of PROJECTIONS) {
      projection.apply[event.kind]?.(this.db, event);
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
    let prev = GENESIS;
    let seq = 0;
    for (const row of this.db
      .prepare("SELECT * FROM events ORDER BY seq")
      .iterate() as Iterable<Row>) {
      const event = rowEvent(row);
      const { hash, ...rest } = event;
      if (
        event.seq !== seq + 1 ||
        event.prevHash !== prev ||
        eventHash(rest) !== hash ||
        canonicalJson(event.payload) !== row.payload
      ) {
        throw new StoreError("chain-broken", `at seq ${event.seq}`);
      }
      prev = hash;
      seq = event.seq;
    }
    return { events: seq, head: { hash: prev, seq } };
  }

  /** Verify the chain, then drop and recreate every projection from the same transaction. */
  rebuild(): VerifyResult {
    return this.transaction(() => {
      const verified = this.verify();
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

export type { Json };
