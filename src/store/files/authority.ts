import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { CONFIG_FILE, type Layout, LEGACY_STATE_DIR } from "../../core/configuration/layout.ts";
import {
  STANDALONE_CONFIG_FILE,
  STANDALONE_STATE_DIR,
} from "../../core/configuration/standalone.ts";
import { isRecord } from "../../core/encoding/pyjson.ts";
import {
  fsyncDirectory,
  readJson,
  tempPrefix,
  writeJsonDurable,
} from "../../core/files/durable.ts";
import { withLock } from "../../core/files/lock.ts";
import type { GitRunner } from "../../core/git.ts";
import { isCanonicalUuid } from "../../core/ids.ts";
import { sha256 } from "../eventCodec.ts";
import { GENESIS, StoreError } from "../types.ts";

const MARKER = "coordination-authority.json";
const LOCK = "coordination-authority.lock";
const TARGET = "coordination";
const WITNESS = "source-fence.json";
const SHA256 = /^[a-f0-9]{64}$/;
const NATIVE_ORIGIN = sha256("coordination-kit-native-file-authority-v1");

/** The persisted fleet cutover shape also records the origin of a new native journal. */
export interface CutoverReceipt {
  readonly head: { readonly hash: string; readonly seq: number };
  readonly id: string;
  readonly legacyPath: string;
  readonly phase: "prepared" | "active";
  readonly proof: string;
  readonly root: string;
  readonly schema: 1;
}

interface ActiveFileAuthority {
  readonly kind: "files";
  readonly path: string;
  readonly receipt: CutoverReceipt;
}

function statIfPresent(path: string): Stats | undefined {
  return lstatSync(path, { throwIfNoEntry: false });
}

function canonicalAbsolute(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path && !path.includes("\0");
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
    const value = readJson(path);
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "head,id,legacyPath,phase,proof,root,schema" ||
      value.schema !== 1 ||
      !isCanonicalUuid(value.id) ||
      typeof value.root !== "string" ||
      !canonicalAbsolute(value.root) ||
      typeof value.legacyPath !== "string" ||
      !canonicalAbsolute(value.legacyPath) ||
      (value.phase !== "prepared" && value.phase !== "active") ||
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
      throw new StoreError("file-authority-selector-invalid");
    }
    return {
      head: { hash: value.head.hash, seq: value.head.seq },
      id: value.id,
      legacyPath: value.legacyPath,
      phase: value.phase,
      proof: value.proof,
      root: value.root,
      schema: 1,
    };
  } catch {
    throw new StoreError("file-authority-selector-invalid");
  }
}

function checkDirectory(path: string, code: string): boolean {
  const file = statIfPresent(path);
  if (file === undefined) {
    return false;
  }
  if (!file.isDirectory() || realpathSync(path) !== path) {
    throw new StoreError(code);
  }
  return true;
}

function ensureDirectory(path: string, parent: string, code: string): void {
  if (checkDirectory(path, code)) {
    return;
  }
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  if (!checkDirectory(path, code)) {
    throw new StoreError(code);
  }
  fsyncDirectory(parent);
}

function assertIgnoredTarget(git: GitRunner, layout: Layout, state: string): void {
  const { root } = layout;
  if (
    !canonicalAbsolute(root) ||
    realpathSync(root) !== root ||
    !statIfPresent(join(root, ".git"))?.isDirectory()
  ) {
    throw new StoreError("file-authority-non-primary-checkout");
  }
  const paths = [TARGET, MARKER, LOCK].map((name) => `${state}/${name}`);
  try {
    const checkout = git(root, ["rev-parse", "--show-toplevel", "--absolute-git-dir"]).trim();
    git(root, ["check-ignore", "--quiet", "--", `${paths[0]}/`]);
    for (const path of paths.slice(1)) {
      git(root, ["check-ignore", "--quiet", "--", path]);
    }
    if (
      checkout !== `${root}\n${join(root, ".git")}` ||
      git(root, ["ls-files", "-z", "--", ...paths]) !== ""
    ) {
      throw new StoreError("file-authority-non-primary-checkout");
    }
  } catch {
    throw new StoreError("file-authority-non-primary-checkout");
  }
}

function assertBinding(layout: Layout, legacyPath: string, receipt: CutoverReceipt): void {
  // A relocated workspace can retain the exact receipt for its previous local origin.
  const priorLocalOrigin =
    layout.mode !== "standalone" &&
    layout.varDir === join(layout.root, STANDALONE_STATE_DIR) &&
    legacyPath === join(layout.varDir, "coordination.db") &&
    receipt.legacyPath === join(layout.root, LEGACY_STATE_DIR, "coordination.db");
  if (receipt.root !== layout.root || (receipt.legacyPath !== legacyPath && !priorLocalOrigin)) {
    throw new StoreError("file-authority-binding-mismatch");
  }
}

function activeAuthority(
  layout: Layout,
  legacyPath: string,
  path: string,
  receipt: CutoverReceipt,
): ActiveFileAuthority {
  assertBinding(layout, legacyPath, receipt);
  if (receipt.phase !== "active") {
    throw new StoreError("file-authority-cutover-pending");
  }
  if (!checkDirectory(path, "file-authority-target-directory")) {
    throw new StoreError("file-authority-target-directory");
  }
  const witness = readReceipt(join(path, WITNESS));
  if (
    witness?.phase !== "prepared" ||
    witness.id !== receipt.id ||
    witness.root !== receipt.root ||
    witness.legacyPath !== receipt.legacyPath ||
    witness.head.hash !== receipt.head.hash ||
    witness.head.seq !== receipt.head.seq ||
    witness.proof !== receipt.proof
  ) {
    throw new StoreError("file-authority-source-fence-mismatch");
  }
  return { kind: "files", path, receipt };
}

function assertNoLegacyState(layout: Layout, legacyPath: string): void {
  const localPath = join(layout.varDir, "coordination.db");
  const sourcePaths = new Set([legacyPath, localPath]);
  if (layout.mode !== "standalone" && layout.varDir === join(layout.root, STANDALONE_STATE_DIR)) {
    sourcePaths.add(join(layout.root, LEGACY_STATE_DIR, "coordination.db"));
  }
  for (const path of sourcePaths) {
    if (["", "-wal", "-shm", "-journal"].some((suffix) => statIfPresent(`${path}${suffix}`))) {
      throw new StoreError("file-authority-legacy-state");
    }
  }
}

function bootstrapWitness(path: string): CutoverReceipt | undefined {
  if (!checkDirectory(path, "file-authority-target-directory")) {
    return undefined;
  }
  const witness = readReceipt(join(path, WITNESS));
  if (
    (witness !== undefined &&
      (witness.phase !== "prepared" ||
        witness.proof !== NATIVE_ORIGIN ||
        witness.head.seq !== 0)) ||
    readdirSync(path).some((name) => name !== WITNESS && !name.startsWith(tempPrefix(WITNESS)))
  ) {
    throw new StoreError("file-authority-selector-missing");
  }
  return witness;
}

/** Resolve an activated journal or explicitly bootstrap the ignored runtime directory on write. */
export function fileAuthority(
  git: GitRunner,
  layout: Layout,
  legacyPath: string,
  options: { readonly create?: boolean } = {},
): ActiveFileAuthority | null {
  const { root, varDir } = layout;
  const canonical = layout.configFile === join(root, STANDALONE_CONFIG_FILE);
  const state = canonical ? STANDALONE_STATE_DIR : LEGACY_STATE_DIR;
  if (
    (!canonical &&
      (layout.mode === "standalone" || layout.configFile !== join(root, CONFIG_FILE))) ||
    varDir !== join(root, state) ||
    !canonicalAbsolute(legacyPath)
  ) {
    throw new StoreError("file-authority-binding-mismatch");
  }
  checkDirectory(varDir, "file-authority-non-primary-checkout");
  const path = join(varDir, TARGET);
  const marker = join(varDir, MARKER);
  const receipt = readReceipt(marker);
  if (receipt !== undefined) {
    assertIgnoredTarget(git, layout, state);
    return activeAuthority(layout, legacyPath, path, receipt);
  }
  assertNoLegacyState(layout, legacyPath);
  if (options.create !== true) {
    try {
      bootstrapWitness(path);
    } catch (error) {
      // A concurrent first writer may have already published its marker and begun appending.
      const activated = readReceipt(marker);
      if (activated !== undefined) {
        assertIgnoredTarget(git, layout, state);
        return activeAuthority(layout, legacyPath, path, activated);
      }
      throw error;
    }
    return null;
  }

  assertIgnoredTarget(git, layout, state);
  ensureDirectory(varDir, root, "file-authority-non-primary-checkout");
  const lock = join(varDir, LOCK);
  const file = statIfPresent(lock);
  if (file !== undefined && (!file.isFile() || file.nlink !== 1)) {
    throw new StoreError("file-authority-lock-invalid");
  }
  return withLock(
    lock,
    () => {
      const activated = readReceipt(marker);
      if (activated !== undefined) {
        return activeAuthority(layout, legacyPath, path, activated);
      }
      assertNoLegacyState(layout, legacyPath);
      const prior = bootstrapWitness(path);
      const witness = prior ?? {
        head: { hash: GENESIS, seq: 0 },
        id: randomUUID(),
        legacyPath,
        phase: "prepared",
        proof: NATIVE_ORIGIN,
        root,
        schema: 1,
      };
      assertBinding(layout, legacyPath, witness);
      ensureDirectory(path, varDir, "file-authority-target-directory");
      if (prior === undefined) {
        writeJsonDurable(join(path, WITNESS), witness);
      }
      const fresh: CutoverReceipt = { ...witness, phase: "active" };
      writeJsonDurable(marker, fresh);
      return { kind: "files", path, receipt: fresh };
    },
    { timeoutSeconds: 5 },
  );
}
