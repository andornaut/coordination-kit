// Reads and revision-checked writes of var/registry.json under var/registry.lock.
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Clock } from "../core/clock.ts";
import {
  type DurableStage,
  readJsonIfExists,
  tempPrefix,
  writeJsonDurable,
} from "../core/durable.ts";
import type { Layout } from "../core/layout.ts";
import { LockError, type LockHandle, withLock } from "../core/lock.ts";
import { type Registry, type RegistryDraft, validateRegistry } from "./schema.ts";

export interface UpdateOptions {
  /** Seconds to wait for var/registry.lock before failing with LockBusy. Default 30. */
  readonly timeoutSeconds?: number;
  /** Test hook passed to the durable write. */
  readonly onStage?: (stage: DurableStage, tempPath: string) => void;
  /**
   * var/registry.lock as the caller already holds it. The write runs under that lock instead of
   * taking a second descriptor, which would wait on the caller's own lock.
   */
  readonly held?: LockHandle;
}

export class RegistryMissing extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path}: registry does not exist`);
    this.name = "RegistryMissing";
    this.path = path;
  }
}

export class RegistryExists extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path}: registry already exists`);
    this.name = "RegistryExists";
    this.path = path;
  }
}

export class RevisionConflict extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`registry revision is ${actual}, expected ${expected}; re-read and retry`);
    this.name = "RevisionConflict";
    this.expected = expected;
    this.actual = actual;
  }
}

const DEFAULT_TIMEOUT_SECONDS = 30;

function readValidated(layout: Layout): Registry | undefined {
  const value = readJsonIfExists(layout.registryFile);
  return value === undefined ? undefined : validateRegistry(layout.config, value);
}

/** A validated snapshot. Its `revision` is the expected revision for a later update. */
export function readRegistry(layout: Layout): Registry {
  const registry = readValidated(layout);
  if (registry === undefined) {
    throw new RegistryMissing(layout.registryFile);
  }
  return registry;
}

// Temp files from a writer that died before its rename. Removed only under the registry lock.
function removeStaleTemps(path: string): void {
  const prefix = tempPrefix(path);
  for (const name of readdirSync(dirname(path))) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) {
      unlinkSync(join(dirname(path), name));
    }
  }
}

function lockAndWrite<T>(layout: Layout, options: UpdateOptions, write: () => T): T {
  mkdirSync(layout.varDir, { mode: 0o700, recursive: true });
  if (options.held !== undefined) {
    if (options.held.path !== layout.registryLock) {
      throw new LockError(options.held.path, `is not ${layout.registryLock}`);
    }
    removeStaleTemps(layout.registryFile);
    return write();
  }
  return withLock(
    layout.registryLock,
    () => {
      removeStaleTemps(layout.registryFile);
      return write();
    },
    { timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS },
  );
}

function persist(
  clock: Clock,
  layout: Layout,
  options: UpdateOptions,
  draft: RegistryDraft,
  revision: number,
): Registry {
  draft.revision = revision;
  draft.updatedAt = clock().toISOString();
  const next = validateRegistry(layout.config, draft);
  writeJsonDurable(
    layout.registryFile,
    next,
    options.onStage === undefined ? {} : { onStage: options.onStage },
  );
  return next;
}

/**
 * Apply `mutate` to a private copy of the current registry under var/registry.lock.
 * Rejects with RevisionConflict when the stored revision is not `expectedRevision`, and with a
 * ValidationError when the result is invalid; either way the file is unchanged. `mutate` may
 * change the draft in place or return a replacement; revision and updatedAt, from `clock`, are set
 * here.
 */
export function updateRegistry(
  clock: Clock,
  layout: Layout,
  expectedRevision: number,
  mutate: (draft: RegistryDraft) => RegistryDraft | void,
  options: UpdateOptions = {},
): Registry {
  return lockAndWrite(layout, options, () => {
    const current = readRegistry(layout);
    if (current.revision !== expectedRevision) {
      throw new RevisionConflict(expectedRevision, current.revision);
    }
    const draft = structuredClone(current) as RegistryDraft;
    return persist(clock, layout, options, mutate(draft) ?? draft, current.revision + 1);
  });
}

/** Write the first registry at revision 1. Rejects with RegistryExists if one is present. */
export function createRegistry(
  clock: Clock,
  layout: Layout,
  initial: Omit<Registry, "revision" | "updatedAt">,
  options: UpdateOptions = {},
): Registry {
  return lockAndWrite(layout, options, () => {
    if (readJsonIfExists(layout.registryFile) !== undefined) {
      throw new RegistryExists(layout.registryFile);
    }
    return persist(
      clock,
      layout,
      options,
      structuredClone({ ...initial, revision: 0, updatedAt: "" }) as RegistryDraft,
      1,
    );
  });
}
