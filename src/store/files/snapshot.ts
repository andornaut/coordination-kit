// Read a consistent SQLite snapshot and qualify independently restorable copies.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { readRoleRoute } from "../../adapters/shared/route.ts";
import { loadProjectConfig } from "../../core/config.ts";
import { fsyncDirectory } from "../../core/durable.ts";
import { appLayout, type Layout, loadLayout, PROJECT_CONFIG_FILE } from "../../core/layout.ts";
import { configuredStateRoot, stateRootConfigPath } from "../../core/stateRoot.ts";
import { readRegistry } from "../../registry/store.ts";
import { READ_ONLY_CLOCK, Store, STORE_FILE, storeRoot } from "../db.ts";
import { canonicalJson, eventHash, sha256 } from "../eventCodec.ts";
import { CURSOR_FILE, LOG_FILE, QUARANTINE_FILE, readCursor } from "../ingest.ts";
import { PROJECTIONS, RETIRED_TABLES } from "../projections.ts";
import { GENESIS, type JsonObject, STORE_SCHEMA, type StoredEvent, StoreError } from "../types.ts";

const BUSY_TIMEOUT_MS = 2500;
const PROJECTION_TABLES = new Set(PROJECTIONS.flatMap(({ tables }) => [...tables]));
// Graph indexes are derived separately from the store and have no authoritative rows.
const REBUILDABLE_TABLES = new Set(["edges", "graph_nodes", "graph_index"]);
const RETIRED = new Set(RETIRED_TABLES);
const EVENT_TABLE = "events";

interface SqliteTableState {
  readonly rows: number;
  readonly sha256: string;
}

export interface SqliteState {
  readonly schema: number;
  readonly events: number;
  readonly head: { readonly seq: number; readonly hash: string };
  readonly eventTable: SqliteTableState;
  readonly projections: Readonly<Record<string, SqliteTableState>>;
  readonly missingProjections: readonly string[];
  readonly derivedTables: readonly string[];
}

interface SqliteSnapshot {
  readonly state: SqliteState;
  /** Private event transfer material. Public qualification receipts use only `state`. */
  readonly events: readonly StoredEvent[];
}

type Row = Record<string, SQLOutputValue>;

function digest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Preserve the SQLite value type, exact integer and bytes in deterministic row digests. */
function digestValue(value: SQLOutputValue): unknown {
  if (typeof value === "bigint") {
    return { integer: value.toString() };
  }
  if (value instanceof Uint8Array) {
    return { bytes: Buffer.from(value).toString("base64") };
  }
  return value;
}

function tableState(db: DatabaseSync, name: string): SqliteTableState {
  const table = quote(name);
  const schema = db.prepare(`PRAGMA table_xinfo(${table})`).all();
  const columns = schema.map(({ name }) => quote(String(name)));
  const ordered = columns.map((column) => `${column} COLLATE BINARY`).join(", ");
  const statement = db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY ${ordered}`);
  statement.setReadBigInts(true);
  const hash = createHash("sha256").update(`${canonicalJson(schema)}\n`);
  let rows = 0;
  for (const row of statement.iterate()) {
    hash.update(`${canonicalJson(Object.values(row).map(digestValue))}\n`);
    rows += 1;
  }
  return { rows, sha256: hash.digest("hex") };
}

function verifiedEvents(db: DatabaseSync, collect: StoredEvent[] | undefined): SqliteState["head"] {
  let head = { hash: GENESIS, seq: 0 };
  for (const row of db.prepare("SELECT * FROM events ORDER BY seq").iterate() as Iterable<Row>) {
    const seq = Number(row.seq);
    try {
      const payload = JSON.parse(String(row.payload)) as JsonObject;
      const draft: Omit<StoredEvent, "hash"> = {
        actor: {
          nativeId: row.actor_native_id as string | null,
          role: row.actor_role as string | null,
          ...(typeof row.actor_worker === "string" ? { worker: row.actor_worker } : {}),
        },
        at: String(row.at),
        key: String(row.key),
        kind: String(row.kind),
        payload,
        prevHash: String(row.prev_hash),
        seq,
      };
      const hash = String(row.hash);
      if (
        Number.isSafeInteger(seq) &&
        seq === head.seq + 1 &&
        draft.prevHash === head.hash &&
        payload !== null &&
        !Array.isArray(payload) &&
        typeof payload === "object" &&
        canonicalJson(payload) === row.payload &&
        eventHash(draft) === hash
      ) {
        collect?.push({ ...draft, hash });
        head = { hash, seq };
        continue;
      }
    } catch {
      // Report the position without exposing event payload or SQLite error text.
    }
    throw new StoreError("snapshot-chain-broken", `after seq ${head.seq}`);
  }
  return head;
}

function readState(db: DatabaseSync, collect?: StoredEvent[]): SqliteState {
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) {
    db.exec("BEGIN");
  }
  try {
    const schema = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (schema !== STORE_SCHEMA) {
      throw new StoreError("snapshot-schema-unsupported");
    }
    if (db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check !== "ok") {
      throw new StoreError("snapshot-integrity-failed");
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all()
      .map(({ name }) => String(name))
      .filter((name) => !name.startsWith("sqlite_"));
    if (
      tables.some(
        (name) =>
          name !== EVENT_TABLE &&
          !PROJECTION_TABLES.has(name) &&
          !REBUILDABLE_TABLES.has(name) &&
          !RETIRED.has(name),
      )
    ) {
      throw new StoreError("snapshot-unknown-tables");
    }
    if (!tables.includes(EVENT_TABLE)) {
      throw new StoreError("snapshot-events-missing");
    }
    const head = verifiedEvents(db, collect);
    const eventTable = tableState(db, EVENT_TABLE);
    const projections = Object.fromEntries(
      tables
        .filter((name) => PROJECTION_TABLES.has(name))
        .map((name) => [name, tableState(db, name)]),
    );
    return {
      derivedTables: tables.filter((name) => REBUILDABLE_TABLES.has(name)),
      eventTable,
      events: head.seq,
      head,
      missingProjections: [...PROJECTION_TABLES].filter((name) => !tables.includes(name)).sort(),
      projections,
      schema,
    };
  } finally {
    if (ownTransaction) {
      db.exec("ROLLBACK");
    }
  }
}

/** Compare every authoritative row and the exact ordered immutable chain. */
export function assertSqliteEquivalent(expected: SqliteState, actual: SqliteState): void {
  if (expected.schema !== actual.schema) {
    throw new StoreError("snapshot-schema-mismatch");
  }
  if (
    expected.events !== actual.events ||
    expected.head.seq !== actual.head.seq ||
    expected.head.hash !== actual.head.hash ||
    !sameTable(expected.eventTable, actual.eventTable)
  ) {
    throw new StoreError("snapshot-events-mismatch");
  }
  if (expected.missingProjections.length > 0 || actual.missingProjections.length > 0) {
    throw new StoreError(
      "snapshot-projection-missing",
      [...new Set([...expected.missingProjections, ...actual.missingProjections])]
        .sort()
        .join(", "),
    );
  }
  const changed = [...PROJECTION_TABLES]
    .filter((name) => !sameTable(expected.projections[name], actual.projections[name]))
    .sort();
  if (changed.length > 0) {
    throw new StoreError("snapshot-projection-mismatch", changed.join(", "));
  }
}

function sameTable(
  expected: SqliteTableState | undefined,
  actual: SqliteTableState | undefined,
): boolean {
  return (
    expected !== undefined &&
    actual !== undefined &&
    expected.rows === actual.rows &&
    expected.sha256 === actual.sha256
  );
}

/** Inspect an already-open connection, joining its transaction if present. */
export function inspectSqliteConnection(db: DatabaseSync): SqliteState {
  return readState(db);
}

function assertSnapshotFile(path: string): void {
  try {
    if (lstatSync(path).isFile()) {
      return;
    }
  } catch {
    // The public error contains no local filesystem location.
  }
  throw new StoreError("snapshot-source-unavailable");
}

function fromFile<T>(path: string, inspect: (db: DatabaseSync) => T): T {
  assertSnapshotFile(path);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
    return inspect(db);
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    const code = (error as { errcode?: number }).errcode;
    throw new StoreError(
      typeof code === "number" && [5, 6].includes(code & 255)
        ? "snapshot-source-busy"
        : "snapshot-sqlite-unavailable",
    );
  } finally {
    db?.close();
  }
}

export function inspectSqliteState(path: string): SqliteState {
  return fromFile(path, inspectSqliteConnection);
}

/** Read one verified sequence and its exact projections from the same read transaction. */
export function readSqliteSnapshot(path: string): SqliteSnapshot {
  return fromFile(path, (db) => {
    const events: StoredEvent[] = [];
    return { events, state: readState(db, events) };
  });
}

function qualifyReplay(copy: string): SqliteState {
  const before = inspectSqliteState(copy);
  let runtime: Store | undefined;
  try {
    runtime = Store.open(READ_ONLY_CLOCK, copy);
    runtime.rebuild();
    assertSqliteEquivalent(before, inspectSqliteConnection(runtime.db));
    return before;
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    throw new StoreError("snapshot-replay-failed");
  } finally {
    runtime?.close();
  }
}

function ensureAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new StoreError("snapshot-destination-unavailable");
  }
  throw new StoreError("snapshot-destination-exists");
}

function clearScratch(directory: string, copies: readonly string[]): void {
  for (const file of copies) {
    for (const suffix of ["-wal", "-shm", "-journal", ""]) {
      try {
        unlinkSync(`${file}${suffix}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new StoreError("snapshot-staging-cleanup-failed");
        }
      }
    }
  }
  rmdirSync(directory);
}

/**
 * VACUUM reads one SQLite transaction, including committed WAL pages, without running the
 * migration or changing the source. Use a fresh private staging directory beside the destination,
 * then publish the standalone checked copy with an exclusive link and fsync.
 */
function makeCopy(source: string, destination: string): SqliteState {
  const target = resolve(destination);
  ensureAbsent(target);
  const directory = dirname(target);
  const scratch = mkdtempSync(join(directory, ".coordination-snapshot-"));
  const staged = join(scratch, STORE_FILE);
  const replay = join(scratch, "replay.db");
  try {
    fromFile(source, (db) => db.prepare("VACUUM INTO ?").run(staged));
    const inventory = inspectSqliteState(staged);
    fromFile(staged, (db) => db.prepare("VACUUM INTO ?").run(replay));
    assertSqliteEquivalent(inventory, qualifyReplay(replay));
    chmodSync(staged, 0o600);
    const fd = openSync(staged, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(staged, target);
    } catch (error) {
      throw new StoreError(
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "snapshot-destination-exists"
          : "snapshot-destination-unavailable",
      );
    }
    fsyncDirectory(directory);
    return inventory;
  } finally {
    clearScratch(scratch, [replay, staged]);
  }
}

/** Export a consistent and replay-qualified standalone backup to a fresh path. */
export function exportSqliteSnapshot(sourcePath: string, backupPath: string): SqliteState {
  return makeCopy(sourcePath, backupPath);
}

/** Restore from the named backup into an independent fresh path and qualify it again. */
export function restoreSqliteSnapshot(backupPath: string, isolatedPath: string): SqliteState {
  return makeCopy(backupPath, isolatedPath);
}

interface SourceStateEntry {
  /** Relative to the named scope. These are known runtime paths, never credential paths. */
  readonly path: string;
  readonly scope: "coordinator" | "sqlite-state" | "game";
  readonly game?: string;
  readonly status: "file" | "directory" | "absent" | "unavailable" | "unexpected-type";
  /** Validated structured input identity when available, without its values. */
  readonly sha256?: string;
}

export interface SqliteSourceInventory {
  readonly schema: 1;
  /** The compatibility baseline. Verify the installed executable's exact pin separately. */
  readonly sourceRelease: "3.1.0";
  readonly registryRevision: number | null;
  readonly entries: readonly SourceStateEntry[];
}

function entry(
  scope: SourceStateEntry["scope"],
  root: string,
  path: string,
  type: "file" | "directory",
): SourceStateEntry {
  try {
    const stats = lstatSync(join(root, path));
    const matches = type === "file" ? stats.isFile() : stats.isDirectory();
    return { path, scope, status: matches ? type : "unexpected-type" };
  } catch (error) {
    return {
      path,
      scope,
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unavailable",
    };
  }
}

function validated(source: SourceStateEntry, read: () => unknown): SourceStateEntry {
  if (source.status !== "file") {
    return source;
  }
  try {
    const value = read();
    return value == null
      ? { ...source, status: "unavailable" }
      : { ...source, sha256: digest(value) };
  } catch {
    return { ...source, status: "unavailable" };
  }
}

/** Identify 3.1.0 inputs to preserve in place; do not read or copy runner logs or native state. */
export function inventorySqliteSource(layout: Layout): SqliteSourceInventory {
  const coordinator = (path: string, type: "file" | "directory" = "file") =>
    entry("coordinator", layout.root, path, type);
  let root: string | null;
  try {
    root = storeRoot(layout);
  } catch {
    root = null;
  }
  const state = (path: string, type: "file" | "directory"): SourceStateEntry =>
    root === null
      ? { path, scope: "sqlite-state", status: "unavailable" }
      : entry("sqlite-state", root, path, type);
  let registryRevision: number | null = null;
  const registry = validated(coordinator("var/registry.json"), () => {
    const value = readRegistry(layout);
    registryRevision = value.revision;
    return value;
  });
  const pointer = stateRootConfigPath(layout).slice(layout.root.length + 1);
  return {
    entries: [
      validated(coordinator("config.json"), () => loadLayout(layout.root).config),
      registry,
      validated(coordinator(pointer), () =>
        root === null ? undefined : configuredStateRoot(layout),
      ),
      validated(coordinator("var/route.json"), () => readRoleRoute(layout)),
      coordinator("var/handoffs", "directory"),
      ...([STORE_FILE, `${STORE_FILE}-wal`, `${STORE_FILE}-shm`] as const).map((path) =>
        state(path, "file"),
      ),
      ...(["wake", "channel", "artifacts", "archive"] as const).map((path) =>
        state(path, "directory"),
      ),
      ...Object.keys(layout.config.apps)
        .sort()
        .flatMap((game) => {
          const project = appLayout(layout, game);
          const prefix = relative(layout.root, project.busDir);
          return [
            validated({ ...entry("game", project.repo, PROJECT_CONFIG_FILE, "file"), game }, () =>
              loadProjectConfig(project.configFile),
            ),
            coordinator(prefix, "directory"),
            validated(coordinator(`${prefix}/${CURSOR_FILE}`), () => readCursor(project.busDir)),
            coordinator(`${prefix}/${LOG_FILE}`),
            coordinator(`${prefix}/${QUARANTINE_FILE}`),
            coordinator(`${prefix}/unblock`, "directory"),
          ];
        }),
    ],
    registryRevision,
    schema: 1,
    sourceRelease: "3.1.0",
  };
}
