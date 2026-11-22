import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isRecord } from "../../adapters/shared/pyjson.ts";
import { readJson, writeJsonDurable } from "../../durable.ts";
import type { Layout } from "../../layout.ts";
import { withLock } from "../../lock.ts";
import { readRegistry } from "../../registry/store.ts";
import { canonicalJson, Store, storePath } from "../db.ts";
import { type StoredEvent, StoreError } from "../types.ts";
import {
  activateFileAuthority,
  type CutoverReceipt,
  fileAuthority,
  fileAuthorityTarget,
  prepareFileAuthority,
} from "./authority.ts";
import { openFileJournal } from "./journal.ts";
import { fileRecords } from "./records.ts";
import {
  assertSqliteEquivalent,
  exportSqliteSnapshot,
  inspectSqliteConnection,
  inspectSqliteState,
  inventorySqliteSource,
  readSqliteSnapshot,
  restoreSqliteSnapshot,
  type SqliteSourceInventory,
  type SqliteState,
} from "./snapshot.ts";

const QUALIFICATION = "qualification.json";
const MIGRATION_LOCK = ".migration.lock";
const BATCH_SIZE = 256;

interface Qualification {
  readonly schema: 1;
  readonly backup: string;
  readonly restored: string;
  readonly source: SqliteState;
  readonly inventory: SqliteSourceInventory;
  readonly records: { readonly count: number; readonly sha256: string };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeCopyPath(layout: Layout, path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {
    throw new StoreError("migration-backup-path");
  }
  const parent = dirname(path);
  if (realpathSync(parent) !== parent) {
    throw new StoreError("migration-backup-path");
  }
  const location = relative(layout.root, path);
  if (
    location === "" ||
    (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`))
  ) {
    throw new StoreError("migration-backup-inside-checkout");
  }
  return path;
}

function sourceInventory(layout: Layout): SqliteSourceInventory {
  const inventory = inventorySqliteSource(layout);
  // SQLite recreates its transient WAL and SHM files as connections open and close.
  return {
    ...inventory,
    entries: inventory.entries.filter(
      ({ path, scope }) =>
        scope !== "sqlite-state" || (!path.endsWith("-wal") && !path.endsWith("-shm")),
    ),
  };
}

function migrationLock<T>(target: string, operation: () => T): T {
  const path = join(target, MIGRATION_LOCK);
  const lock = lstatSync(path, { throwIfNoEntry: false });
  if (lock !== undefined && (!lock.isFile() || lock.nlink !== 1)) {
    throw new StoreError("migration-lock-invalid");
  }
  return withLock(path, operation, { timeoutSeconds: 5 });
}

function checkRecordManifest(
  events: readonly StoredEvent[],
  records: readonly { readonly path: string; readonly sha256: string }[],
  roles: ReadonlySet<string>,
): Qualification["records"] {
  const expected = fileRecords(events, { registeredRoles: roles });
  const actual = new Map(records.map(({ path, sha256 }) => [path, sha256]));
  if (
    actual.size !== records.length ||
    actual.size !== expected.length ||
    expected.some(({ data, path }) => actual.get(path) !== hash(`${canonicalJson(data)}\n`))
  ) {
    throw new StoreError("migration-record-mismatch");
  }
  return { count: records.length, sha256: hash(canonicalJson([...actual].sort())) };
}

function inspectTarget(
  target: string,
  expected: SqliteState,
  roles: ReadonlySet<string>,
): Qualification["records"] {
  const snapshot = openFileJournal(target).snapshot();
  const index = Store.openFileProjection(target, {
    journal: {
      events: () => [...snapshot.events],
      withWriter: () => {
        throw new StoreError("migration-index-read-only");
      },
    },
    records: () => [],
  });
  try {
    assertSqliteEquivalent(expected, inspectSqliteConnection(index.db));
    return checkRecordManifest(snapshot.events, snapshot.records, roles);
  } finally {
    index.close();
  }
}

export function prepareMigration(
  layout: Layout,
  backupPath: string,
  restorePath: string,
): { readonly receipt: CutoverReceipt; readonly qualification: Qualification } {
  const legacy = storePath(layout);
  const backup = safeCopyPath(layout, backupPath);
  const restored = safeCopyPath(layout, restorePath);
  if (
    fileAuthority(layout, legacy).kind !== "sqlite" ||
    backup === restored ||
    backup === legacy ||
    restored === legacy
  ) {
    throw new StoreError("migration-already-active-or-copy-conflict");
  }
  const target = fileAuthorityTarget(layout, { create: true });
  return migrationLock(target, () => {
    const inventory = sourceInventory(layout);
    const roles = new Set(Object.keys(readRegistry(layout).roles));
    const source = exportSqliteSnapshot(legacy, backup);
    assertSqliteEquivalent(source, restoreSqliteSnapshot(backup, restored));
    const { events } = readSqliteSnapshot(restored);
    const bySequence = new Map<number, ReturnType<typeof fileRecords>[number][]>();
    for (const entry of fileRecords(events, { registeredRoles: roles })) {
      const seq = isRecord(entry.data) ? entry.data.seq : undefined;
      if (typeof seq !== "number") {
        throw new StoreError("migration-invalid-record");
      }
      const entries = bySequence.get(seq) ?? [];
      entries.push(entry);
      bySequence.set(seq, entries);
    }
    openFileJournal(target).withWriter((writer) => {
      const previous = writer.events();
      if (
        previous.length > events.length ||
        previous.some((entry, i) => entry.hash !== events[i]!.hash)
      ) {
        throw new StoreError("migration-candidate-diverged");
      }
      for (let offset = previous.length; offset < events.length; offset += BATCH_SIZE) {
        const batch = events.slice(offset, offset + BATCH_SIZE);
        writer.commit(
          batch,
          batch.flatMap(({ seq }) => bySequence.get(seq) ?? []),
        );
      }
    });

    const records = inspectTarget(target, source, roles);
    const qualification: Qualification = {
      backup,
      inventory,
      records,
      restored,
      schema: 1,
      source,
    };
    const receipt = prepareFileAuthority(
      layout,
      legacy,
      { head: source.head, proof: hash(canonicalJson(qualification)) },
      (_path, _receipt, currentSource) => {
        if (currentSource === undefined) {
          throw new StoreError("migration-source-unavailable");
        }
        assertSqliteEquivalent(source, inspectSqliteConnection(currentSource));
        if (canonicalJson(inventory) !== canonicalJson(sourceInventory(layout))) {
          throw new StoreError("migration-source-inventory-changed");
        }
        writeJsonDurable(join(target, QUALIFICATION), qualification);
      },
    );
    return { qualification, receipt };
  });
}

function readQualification(path: string, receipt: CutoverReceipt): Qualification {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw new StoreError("migration-qualification-invalid");
  }
  const value = readJson(path);
  if (!isRecord(value) || value.schema !== 1 || hash(canonicalJson(value)) !== receipt.proof) {
    throw new StoreError("migration-qualification-mismatch");
  }
  return value as unknown as Qualification;
}

export function activateMigration(layout: Layout, id: string): CutoverReceipt {
  const target = fileAuthorityTarget(layout);
  return migrationLock(target, () =>
    activateFileAuthority(layout, storePath(layout), id, (_path, receipt, currentSource) => {
      const expected = readQualification(join(target, QUALIFICATION), receipt);
      if (currentSource !== undefined) {
        assertSqliteEquivalent(expected.source, inspectSqliteConnection(currentSource));
      }
      assertSqliteEquivalent(expected.source, inspectSqliteState(expected.backup));
      assertSqliteEquivalent(expected.source, inspectSqliteState(expected.restored));
      if (canonicalJson(expected.inventory) !== canonicalJson(sourceInventory(layout))) {
        throw new StoreError("migration-source-inventory-changed");
      }
      const records = inspectTarget(
        target,
        expected.source,
        new Set(Object.keys(readRegistry(layout).roles)),
      );
      if (canonicalJson(records) !== canonicalJson(expected.records)) {
        throw new StoreError("migration-record-mismatch");
      }
    }),
  );
}
