import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isRecord } from "../../adapters/shared/pyjson.ts";
import { fsyncDirectory, readJson, writeJsonDurable } from "../../durable.ts";
import type { Layout } from "../../layout.ts";
import { withLock } from "../../lock.ts";
import { systemGit } from "../../status/git.ts";
import { GENESIS, StoreError } from "../types.ts";

const MARKER = "coordination-authority.json";
const LOCK = "coordination-authority.lock";
const TARGET = "coordination";
const WITNESS = "source-fence.json";
const FENCE = "coordination_file_authority";
const TRIGGER = "coordination_file_authority_no_insert";
const FENCE_DDL = `CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON events
  BEGIN SELECT RAISE(ABORT, 'store-authority-frozen'); END`;
const FENCE_TABLE_DDL = `CREATE TABLE ${FENCE} (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  receipt TEXT NOT NULL
)`;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const WAIT_SECONDS = 5;

export interface CutoverEvidence {
  readonly head: { readonly hash: string; readonly seq: number };
  /** Digest of the qualified state comparison and independent backup/restore evidence. */
  readonly proof: string;
}

export interface CutoverReceipt extends CutoverEvidence {
  readonly id: string;
  readonly legacyPath: string;
  readonly phase: "prepared" | "active";
  readonly root: string;
  readonly schema: 1;
}

interface ActiveFileAuthority {
  readonly kind: "files";
  readonly path: string;
  readonly receipt: CutoverReceipt;
}

export type FileAuthority =
  { readonly kind: "sqlite"; readonly path: string } | ActiveFileAuthority;

export type FileAuthorityStatus =
  | { readonly kind: "sqlite"; readonly path: string; readonly receipt?: CutoverReceipt }
  | { readonly kind: "pending"; readonly path: string; readonly receipt: CutoverReceipt }
  | ActiveFileAuthority;

/** Inspect the target and any unfenced source within the source write transaction. */
export type VerifyCutoverTarget = (
  path: string,
  receipt: CutoverReceipt,
  unfencedSource?: DatabaseSync,
) => void;

function verifyCutoverTarget(
  verify: VerifyCutoverTarget,
  target: string,
  receipt: CutoverReceipt,
  unfencedSource?: DatabaseSync,
): void {
  const result: unknown = verify(target, receipt, unfencedSource);
  if (result instanceof Promise) {
    throw new StoreError("file-authority-proof-async");
  }
}

function statIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

function parseEvidence(value: unknown): CutoverEvidence {
  if (
    !isRecord(value) ||
    !isRecord(value.head) ||
    Object.keys(value.head).sort().join(",") !== "hash,seq" ||
    typeof value.head.seq !== "number" ||
    !Number.isSafeInteger(value.head.seq) ||
    value.head.seq < 0 ||
    typeof value.head.hash !== "string" ||
    !SHA256.test(value.head.hash) ||
    (value.head.seq === 0) !== (value.head.hash === GENESIS) ||
    typeof value.proof !== "string" ||
    !SHA256.test(value.proof)
  ) {
    throw new StoreError("file-authority-evidence-invalid");
  }
  return { head: { hash: value.head.hash, seq: value.head.seq }, proof: value.proof };
}

function parseReceipt(value: unknown): CutoverReceipt {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "head,id,legacyPath,phase,proof,root,schema" ||
    value.schema !== 1 ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    typeof value.root !== "string" ||
    !canonicalAbsolute(value.root) ||
    typeof value.legacyPath !== "string" ||
    !canonicalAbsolute(value.legacyPath) ||
    (value.phase !== "prepared" && value.phase !== "active")
  ) {
    throw new StoreError("file-authority-selector-invalid");
  }
  return {
    ...parseEvidence(value),
    id: value.id,
    legacyPath: value.legacyPath,
    phase: value.phase,
    root: value.root,
    schema: 1,
  };
}

function canonicalAbsolute(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path && !path.includes("\0");
}

/** Resolve the ignored target in the explicitly selected primary checkout. */
export function fileAuthorityTarget(
  layout: Layout,
  options: { readonly create?: boolean } = {},
): string {
  const { root, varDir } = layout;
  if (
    !canonicalAbsolute(root) ||
    varDir !== join(root, "var") ||
    realpathSync(root) !== root ||
    !statIfPresent(join(root, ".git"))?.isDirectory() ||
    !statIfPresent(varDir)?.isDirectory()
  ) {
    throw new StoreError("file-authority-non-primary-checkout");
  }
  const target = join(varDir, TARGET);
  const existing = statIfPresent(target);
  if (existing !== undefined && (!existing.isDirectory() || realpathSync(target) !== target)) {
    throw new StoreError("file-authority-target-directory");
  }

  const git = systemGit(process.env);
  const paths = [`var/${TARGET}`, `var/${MARKER}`, `var/${LOCK}`];
  try {
    const checkout = git(root, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]).trim();
    git(root, ["check-ignore", "--quiet", "--", `var/${TARGET}/`]);
    git(root, ["check-ignore", "--quiet", "--", `var/${MARKER}`]);
    git(root, ["check-ignore", "--quiet", "--", `var/${LOCK}`]);
    if (
      checkout !== `${root}\n${join(root, ".git")}` ||
      git(root, ["ls-files", "-z", "--", ...paths]) !== ""
    ) {
      throw new StoreError("file-authority-non-primary-checkout");
    }
  } catch {
    throw new StoreError("file-authority-non-primary-checkout");
  }
  if (options.create === true && statIfPresent(target) === undefined) {
    try {
      mkdirSync(target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    fsyncDirectory(varDir);
  }
  if (!statIfPresent(target)?.isDirectory() || realpathSync(target) !== target) {
    throw new StoreError("file-authority-target-directory");
  }
  return target;
}

function readReceipt(path: string): CutoverReceipt | undefined {
  const file = statIfPresent(path);
  if (file === undefined) {
    return undefined;
  }
  if (!file.isFile() || file.nlink !== 1) {
    throw new StoreError("file-authority-selector-invalid");
  }
  try {
    return parseReceipt(readJson(path));
  } catch {
    throw new StoreError("file-authority-selector-invalid");
  }
}

function assertBinding(layout: Layout, legacyPath: string, receipt: CutoverReceipt): void {
  if (receipt.root !== layout.root || receipt.legacyPath !== legacyPath) {
    throw new StoreError("file-authority-binding-mismatch");
  }
}

function readHead(db: DatabaseSync): CutoverEvidence["head"] {
  const row = db.prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1").get();
  if (row === undefined) {
    return { hash: GENESIS, seq: 0 };
  }
  if (
    typeof row.seq !== "number" ||
    !Number.isSafeInteger(row.seq) ||
    row.seq <= 0 ||
    typeof row.hash !== "string" ||
    !SHA256.test(row.hash) ||
    row.hash === GENESIS
  ) {
    throw new StoreError("file-authority-source-head-invalid");
  }
  return { hash: row.hash, seq: row.seq };
}

function assertHead(db: DatabaseSync, receipt: CutoverEvidence): void {
  const head = readHead(db);
  if (head.seq !== receipt.head.seq || head.hash !== receipt.head.hash) {
    throw new StoreError("file-authority-source-head-changed");
  }
}

function readFence(db: DatabaseSync): CutoverReceipt | undefined {
  const objects = db
    .prepare("SELECT name, sql, type FROM sqlite_schema WHERE name IN (?, ?)")
    .all(FENCE, TRIGGER);
  if (objects.length === 0) {
    return undefined;
  }
  const table = objects.find((entry) => entry.name === FENCE && entry.type === "table");
  const trigger = objects.find((entry) => entry.name === TRIGGER && entry.type === "trigger");
  if (objects.length !== 2 || table?.sql !== FENCE_TABLE_DDL || trigger?.sql !== FENCE_DDL) {
    throw new StoreError("file-authority-source-fence-invalid");
  }
  const rows = db.prepare(`SELECT singleton, receipt FROM ${FENCE}`).all();
  const record = rows[0];
  if (rows.length !== 1 || record?.singleton !== 1 || typeof record.receipt !== "string") {
    throw new StoreError("file-authority-source-fence-invalid");
  }
  try {
    const receipt = parseReceipt(JSON.parse(record.receipt) as unknown);
    if (receipt.phase === "prepared") {
      assertHead(db, receipt);
      return receipt;
    }
  } catch {
    throw new StoreError("file-authority-source-fence-invalid");
  }
  throw new StoreError("file-authority-source-fence-invalid");
}

function legacyDb(path: string, readOnly: boolean): DatabaseSync {
  const file = statIfPresent(path);
  if (!file?.isFile() || file.nlink !== 1 || realpathSync(path) !== path) {
    throw new StoreError("file-authority-source-invalid");
  }
  return new DatabaseSync(path, { readOnly, timeout: WAIT_SECONDS * 1000 });
}

function frozenSource(path: string): CutoverReceipt | undefined {
  if (statIfPresent(path) === undefined) {
    return undefined;
  }
  const db = legacyDb(path, true);
  try {
    db.exec("BEGIN");
    return readFence(db);
  } finally {
    db.close();
  }
}

function sameEvidence(left: CutoverEvidence, right: CutoverEvidence): boolean {
  return (
    left.head.hash === right.head.hash &&
    left.head.seq === right.head.seq &&
    left.proof === right.proof
  );
}

function assertFence(receipt: CutoverReceipt, fence: CutoverReceipt | undefined): void {
  if (
    fence?.id !== receipt.id ||
    fence.phase !== "prepared" ||
    fence.root !== receipt.root ||
    fence.legacyPath !== receipt.legacyPath ||
    !sameEvidence(receipt, fence)
  ) {
    throw new StoreError("file-authority-source-fence-mismatch");
  }
}

/** Read the validated selector and freeze together, including an interrupted cutover. */
export function inspectFileAuthority(layout: Layout, legacyPath: string): FileAuthorityStatus {
  const receipt = readReceipt(join(layout.varDir, MARKER));
  const fence = frozenSource(legacyPath);
  if (receipt === undefined) {
    if (fence !== undefined || statIfPresent(join(layout.varDir, TARGET, WITNESS)) !== undefined) {
      throw new StoreError("file-authority-selector-missing");
    }
    return { kind: "sqlite", path: legacyPath };
  }
  const target = fileAuthorityTarget(layout);
  assertBinding(layout, legacyPath, receipt);
  if (receipt.phase === "prepared") {
    if (fence !== undefined) {
      assertFence(receipt, fence);
      return { kind: "pending", path: target, receipt };
    }
    if (statIfPresent(join(target, WITNESS)) !== undefined) {
      throw new StoreError("file-authority-source-fence-mismatch");
    }
    if (statIfPresent(legacyPath) === undefined) {
      throw new StoreError("file-authority-source-invalid");
    }
    return { kind: "sqlite", path: legacyPath, receipt };
  }
  assertFence(receipt, fence);
  assertFence(receipt, readReceipt(join(target, WITNESS)));
  return { kind: "files", path: target, receipt };
}

/** An absent selector only permits SQLite when the legacy source has never been fenced. */
export function fileAuthority(layout: Layout, legacyPath: string): FileAuthority {
  const selection = inspectFileAuthority(layout, legacyPath);
  if (selection.kind === "pending") {
    throw new StoreError("file-authority-cutover-pending");
  }
  return selection.kind === "sqlite" ? { kind: "sqlite", path: selection.path } : selection;
}

function withSourceWriter<T>(path: string, operation: (source: DatabaseSync) => T): T {
  const source = legacyDb(path, false);
  try {
    source.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
    const result = operation(source);
    source.exec("COMMIT");
    return result;
  } finally {
    source.close();
  }
}

function authorityLock<T>(layout: Layout, operation: () => T): T {
  const path = join(layout.varDir, LOCK);
  const file = statIfPresent(path);
  if (file !== undefined && (!file.isFile() || file.nlink !== 1)) {
    throw new StoreError("file-authority-lock-invalid");
  }
  return withLock(path, operation, { timeoutSeconds: WAIT_SECONDS });
}

/** Record an inspected candidate. SQLite remains authoritative until activation freezes it. */
export function prepareFileAuthority(
  layout: Layout,
  legacyPath: string,
  evidence: CutoverEvidence,
  verifyTarget: VerifyCutoverTarget,
): CutoverReceipt {
  const target = fileAuthorityTarget(layout);
  const verified = parseEvidence(evidence);
  return authorityLock(layout, () =>
    withSourceWriter(legacyPath, (source) => {
      const previous = readReceipt(join(layout.varDir, MARKER));
      if (previous !== undefined) {
        assertBinding(layout, legacyPath, previous);
      }
      if (
        readFence(source) !== undefined ||
        previous?.phase === "active" ||
        statIfPresent(join(target, WITNESS)) !== undefined
      ) {
        throw new StoreError("file-authority-already-fenced");
      }
      assertHead(source, verified);
      const receipt: CutoverReceipt =
        previous !== undefined && sameEvidence(previous, verified)
          ? previous
          : {
              ...verified,
              id: randomUUID(),
              legacyPath,
              phase: "prepared",
              root: layout.root,
              schema: 1,
            };
      verifyCutoverTarget(verifyTarget, target, receipt, source);
      if (receipt !== previous) {
        writeJsonDurable(join(layout.varDir, MARKER), receipt);
      }
      return receipt;
    }),
  );
}

/** Freeze SQLite before publishing the active selector. Retry with the same receipt after a crash. */
export function activateFileAuthority(
  layout: Layout,
  legacyPath: string,
  id: string,
  verifyTarget: VerifyCutoverTarget,
  options: {
    /** Test hook between the source commit and selector publication. */ readonly onFrozen?: () => void;
  } = {},
): CutoverReceipt {
  const target = fileAuthorityTarget(layout);
  return authorityLock(layout, () => {
    const receipt = readReceipt(join(layout.varDir, MARKER));
    if (receipt === undefined || receipt.id !== id) {
      throw new StoreError("file-authority-cutover-receipt-mismatch");
    }
    assertBinding(layout, legacyPath, receipt);
    const witnessPath = join(target, WITNESS);
    const witness = readReceipt(witnessPath);
    if (receipt.phase === "active" || witness !== undefined) {
      assertFence(receipt, witness);
    }
    withSourceWriter(legacyPath, (source) => {
      const fence = readFence(source);
      if (fence !== undefined || witness !== undefined || receipt.phase === "active") {
        assertFence(receipt, fence);
      }
      if (receipt.phase === "prepared") {
        assertHead(source, receipt);
        verifyCutoverTarget(
          verifyTarget,
          target,
          receipt,
          fence === undefined ? source : undefined,
        );
        if (fence === undefined) {
          source.exec(`${FENCE_TABLE_DDL}; ${FENCE_DDL};`);
          source.prepare(`INSERT INTO ${FENCE} VALUES (1, ?)`).run(JSON.stringify(receipt));
        }
      }
    });
    if (receipt.phase === "active") {
      return receipt;
    }
    options.onFrozen?.();
    if (witness === undefined) {
      writeJsonDurable(witnessPath, receipt);
    }
    const active: CutoverReceipt = { ...receipt, phase: "active" };
    writeJsonDurable(join(layout.varDir, MARKER), active);
    return active;
  });
}
