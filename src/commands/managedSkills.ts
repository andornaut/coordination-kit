import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Io } from "../core/cli/io.ts";
import { writeDurable } from "../core/files/durable.ts";
import { LockBusy, withLock } from "../core/files/lock.ts";

export const SKILL_DIRECTORIES = { claude: ".claude", codex: ".agents" } as const;
export const MANAGED_SKILLS = {
  handoff: "coordination-handoff",
  lifecycle: "coordination-lifecycle",
  recovery: "coordination-recovery",
  status: "coordination-status",
} as const;

export type SkillHarness = keyof typeof SKILL_DIRECTORIES;
type Skill = keyof typeof MANAGED_SKILLS;
const SKILLS = Object.keys(MANAGED_SKILLS) as Skill[];
const SHA256 = /^[0-9a-f]{64}$/;
const MANIFEST = ".coordination-kit.json";

interface ManifestEntry {
  readonly sha256: string;
  /** During an interrupted sync, only this exact prior digest is also trusted. */
  readonly previous?: string;
}

interface Manifest {
  readonly schema: 1;
  readonly skills: Partial<Record<Skill, ManifestEntry>>;
}

type ConflictReason =
  | "adoption-digest-mismatch"
  | "entry-changed"
  | "invalid-manifest"
  | "not-directory"
  | "not-regular-file"
  | "sync-in-progress"
  | "unmanaged-bytes";

interface Conflict {
  readonly path: string;
  readonly reason: ConflictReason;
  readonly sha256?: string;
  readonly skill?: Skill;
}

interface SyncedSkill {
  readonly action: "adopted" | "installed" | "unchanged" | "updated";
  readonly path: string;
  readonly sha256: string;
  readonly skill: Skill;
}

interface SkillUpdate {
  readonly current: string | null;
  readonly bytes: Buffer;
  readonly result: SyncedSkill;
}

export type SkillSyncResult = { readonly harness: SkillHarness; readonly manifest: string } & (
  | { readonly conflicts: readonly Conflict[]; readonly status: "conflict" }
  | { readonly skills: readonly SyncedSkill[]; readonly status: "synced" }
);

class SkillConflict extends Error {
  readonly conflict: Conflict;

  constructor(conflict: Conflict) {
    super(conflict.reason);
    this.conflict = conflict;
  }
}

function conflict(path: string, reason: ConflictReason): never {
  throw new SkillConflict({ path, reason });
}

export function bundledSkill(io: Io, name: string): Buffer {
  const assets =
    io.entry === undefined
      ? fileURLToPath(new URL("../../skills", import.meta.url))
      : join(dirname(io.entry), "..", "skills");
  return readFileSync(join(assets, name, "SKILL.md"));
}

export function skillDirectory(parent: string, name: string): string {
  const path = join(parent, name);
  try {
    mkdirSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  if (!lstatSync(path).isDirectory()) {
    throw new Error(`${path}: expected a directory`);
  }
  return path;
}

function existingSkillMatches(path: string, bytes: Buffer): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) {
    return false;
  }
  if (!entry.isFile() || !readFileSync(path).equals(bytes)) {
    throw new Error(`${path}: review the existing entry before installing the bundled skill`);
  }
  return true;
}

export function installSkill(directory: string, bytes: Buffer): boolean {
  const file = join(directory, "SKILL.md");
  if (existingSkillMatches(file, bytes)) {
    return false;
  }
  const scratch = mkdtempSync(join(directory, ".install-"));
  try {
    const candidate = join(scratch, "SKILL.md");
    writeFileSync(candidate, bytes, { mode: 0o644 });
    try {
      linkSync(candidate, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && existingSkillMatches(file, bytes)) {
        return false;
      }
      throw error;
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkDirectory(checkout: string, path: string): void {
  const existing = lstatSync(join(checkout, path), { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isDirectory()) {
    conflict(path, "not-directory");
  }
}

/** Inspect the fixed path without reading symlink targets or special files. */
function readEntry(checkout: string, path: string): Buffer | null {
  const file = join(checkout, path);
  const existing = lstatSync(file, { throwIfNoEntry: false });
  if (existing === undefined) {
    return null;
  }
  if (!existing.isFile()) {
    conflict(path, "not-regular-file");
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) {
      conflict(path, "not-regular-file");
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function digestOf(entry: Buffer | null): string | null {
  return entry === null ? null : digest(entry);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function manifestOf(path: string, bytes: Buffer | null): Manifest {
  if (bytes === null) {
    return { schema: 1, skills: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    conflict(path, "invalid-manifest");
  }
  if (
    !object(parsed) ||
    parsed.schema !== 1 ||
    !object(parsed.skills) ||
    Object.keys(parsed).length !== 2
  ) {
    conflict(path, "invalid-manifest");
  }
  const skills: Partial<Record<Skill, ManifestEntry>> = {};
  for (const [key, entry] of Object.entries(parsed.skills)) {
    if (
      !Object.hasOwn(MANAGED_SKILLS, key) ||
      !object(entry) ||
      !sha(entry.sha256) ||
      !Object.keys(entry).every((field) => field === "sha256" || field === "previous") ||
      (entry.previous !== undefined && !sha(entry.previous))
    ) {
      conflict(path, "invalid-manifest");
    }
    skills[key as Skill] = {
      ...(entry.previous === undefined ? {} : { previous: entry.previous }),
      sha256: entry.sha256,
    };
  }
  return { schema: 1, skills };
}

type Approvals = ReadonlyMap<Skill, string>;

export function skillAdoptions(values: readonly string[]): Approvals | null {
  const approvals = new Map<Skill, string>();
  for (const value of values) {
    const [name, expected, ...other] = value.split("=");
    const skill = name as Skill;
    if (
      !Object.hasOwn(MANAGED_SKILLS, skill) ||
      !sha(expected) ||
      other.length > 0 ||
      approvals.has(skill)
    ) {
      return null;
    }
    approvals.set(skill, expected);
  }
  return approvals;
}

function planSkill(
  io: Io,
  checkout: string,
  base: string,
  manifest: Manifest,
  approvals: Approvals,
  skill: Skill,
): SkillUpdate {
  const folder = join(base, MANAGED_SKILLS[skill]);
  const path = join(folder, "SKILL.md");
  checkDirectory(checkout, folder);
  const bytes = bundledSkill(io, MANAGED_SKILLS[skill]);
  const sha256 = digest(bytes);
  const current = digestOf(readEntry(checkout, path));
  const managed = manifest.skills[skill];
  const approved = approvals.get(skill);
  if (current !== null && current !== sha256) {
    const reason =
      approved !== undefined && approved !== current
        ? "adoption-digest-mismatch"
        : approved !== current && managed?.sha256 !== current && managed?.previous !== current
          ? "unmanaged-bytes"
          : null;
    if (reason !== null) {
      throw new SkillConflict({ path, reason, sha256: current, skill });
    }
  }
  const action =
    current === null
      ? "installed"
      : current !== sha256
        ? "updated"
        : managed?.sha256 === sha256
          ? "unchanged"
          : "adopted";
  return { bytes, current, result: { action, path, sha256, skill } };
}

function manifestBytes(updates: readonly SkillUpdate[], pending: boolean): Buffer {
  const skills = Object.fromEntries(
    updates.map(({ current, result }) => [
      result.skill,
      {
        ...(pending && current !== null && current !== result.sha256 ? { previous: current } : {}),
        sha256: result.sha256,
      },
    ]),
  );
  return Buffer.from(`${JSON.stringify({ schema: 1, skills }, null, 2)}\n`);
}

// File replacement runs under the checkout lock and also rejects edits made during preflight.
function checkedWrite(checkout: string, path: string, bytes: Buffer, old: string | null): void {
  writeDurable(join(checkout, path), bytes, {
    mode: 0o644,
    onStage(stage) {
      if (stage === "synced" && digestOf(readEntry(checkout, path)) !== old) {
        conflict(path, "entry-changed");
      }
    },
  });
}

function sync(
  io: Io,
  checkout: string,
  harness: SkillHarness,
  harnessDirectory: string,
  manifest: string,
  approvals: Approvals,
): SkillSyncResult {
  const base = dirname(manifest);
  checkDirectory(checkout, harnessDirectory);
  checkDirectory(checkout, base);
  const old = readEntry(checkout, manifest);
  const current = manifestOf(manifest, old);
  const updates: SkillUpdate[] = [];
  const conflicts: Conflict[] = [];
  for (const skill of SKILLS) {
    try {
      updates.push(planSkill(io, checkout, base, current, approvals, skill));
    } catch (error) {
      if (!(error instanceof SkillConflict)) {
        throw error;
      }
      conflicts.push({ ...error.conflict, skill });
    }
  }
  if (conflicts.length > 0) {
    return { conflicts, harness, manifest, status: "conflict" };
  }

  const changed = updates.filter(({ current, result }) => current !== result.sha256);
  const final = manifestBytes(updates, false);
  if (changed.length === 0 && old?.equals(final)) {
    return { harness, manifest, skills: updates.map(({ result }) => result), status: "synced" };
  }
  skillDirectory(skillDirectory(checkout, harnessDirectory), "skills");
  // Publish the exact allowed old digests before replacing files. A retry trusts only the
  // previously authorized input or a bundled output, even when the kit has since been updated.
  const intent = manifestBytes(updates, true);
  if (!old?.equals(intent)) {
    checkedWrite(checkout, manifest, intent, digestOf(old));
  }
  for (const update of changed) {
    checkDirectory(checkout, harnessDirectory);
    checkDirectory(checkout, base);
    const folder = dirname(update.result.path);
    const target = skillDirectory(join(checkout, base), MANAGED_SKILLS[update.result.skill]);
    if (update.current === null) {
      try {
        installSkill(target, update.bytes);
      } catch (error) {
        if (digestOf(readEntry(checkout, update.result.path)) !== null) {
          conflict(update.result.path, "entry-changed");
        }
        throw error;
      }
    } else {
      checkDirectory(checkout, folder);
      checkedWrite(checkout, update.result.path, update.bytes, update.current);
    }
  }
  if (!intent.equals(final)) {
    checkDirectory(checkout, harnessDirectory);
    checkDirectory(checkout, base);
    checkedWrite(checkout, manifest, final, digest(intent));
  }
  return { harness, manifest, skills: updates.map(({ result }) => result), status: "synced" };
}

export function syncManagedProjectSkills(
  io: Io,
  checkout: string,
  harness: SkillHarness,
  approvals: Approvals,
): SkillSyncResult {
  const harnessDirectory = SKILL_DIRECTORIES[harness];
  const manifest = join(harnessDirectory, "skills", MANIFEST);
  try {
    checkDirectory(checkout, ".");
    return withLock(
      checkout,
      () => sync(io, checkout, harness, harnessDirectory, manifest, approvals),
      { nonBlocking: true, readOnly: true },
    );
  } catch (error) {
    if (error instanceof LockBusy) {
      return {
        conflicts: [{ path: manifest, reason: "sync-in-progress" }],
        harness,
        manifest,
        status: "conflict",
      };
    }
    if (error instanceof SkillConflict) {
      return { conflicts: [error.conflict], harness, manifest, status: "conflict" };
    }
    throw error;
  }
}

export function syncProjectSkills(
  io: Io,
  checkout: string,
  harness: SkillHarness,
): SkillSyncResult {
  return syncManagedProjectSkills(io, checkout, harness, new Map());
}
