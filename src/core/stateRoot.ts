// The external state root. `var/work-protocol.json` names it: `{"schema":2,"stateRoot":"/abs"}`,
// or the 2.1 shape (`schema` 1 with `workspaceId` and `generation`), which is read and never
// written. Without the file the state root is the coordinator's `var/`. The root must be absolute
// and outside every configured repository, registered worktree and Git checkout.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { readJsonIfExists } from "./durable.ts";
import type { Layout } from "./layout.ts";
import { isRecord } from "./pyjson.ts";

export const STATE_ROOT_SCHEMA = 2;

export type StateRootCode = "invalid-state-root-config" | "state-root-excluded";

export class StateRootError extends Error {
  readonly code: StateRootCode;

  constructor(code: StateRootCode) {
    super(code);
    this.code = code;
  }
}

export function stateRootConfigPath(layout: Pick<Layout, "varDir">): string {
  return join(layout.varDir, "work-protocol.json");
}

/** The configured state root path as written, or null without a configuration file. */
export function configuredStateRoot(layout: Pick<Layout, "varDir">): string | null {
  let value: unknown;
  try {
    value = readJsonIfExists(stateRootConfigPath(layout));
  } catch {
    throw new StateRootError("invalid-state-root-config");
  }
  if (value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    throw new StateRootError("invalid-state-root-config");
  }
  const keys = Object.keys(value).sort().join(",");
  const current = keys === "schema,stateRoot" && value.schema === STATE_ROOT_SCHEMA;
  const legacy =
    (keys === "generation,schema,stateRoot,workspaceId" ||
      keys === "generation,required,schema,stateRoot,workspaceId") &&
    value.schema === 1;
  if (!(current || legacy) || typeof value.stateRoot !== "string") {
    throw new StateRootError("invalid-state-root-config");
  }
  return value.stateRoot;
}

/** Resolve existing aliases without creating a missing destination. */
function canonical(path: string): string {
  let cursor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(cursor), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new StateRootError("invalid-state-root-config");
      }
      missing.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function hasGitAncestor(target: string): boolean {
  for (let cursor = target; ; cursor = dirname(cursor)) {
    try {
      lstatSync(join(cursor, ".git"));
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }
    if (dirname(cursor) === cursor) {
      return false;
    }
  }
}

/** The worktrees the registry names, read without validating the registry. */
function registeredWorktrees(layout: Layout): string[] {
  try {
    const registry = readJsonIfExists(layout.registryFile);
    const roles = isRecord(registry) && isRecord(registry.roles) ? registry.roles : {};
    return Object.values(roles).flatMap((role) =>
      isRecord(role) && typeof role.worktree === "string"
        ? [resolve(layout.root, role.worktree)]
        : [],
    );
  } catch {
    return [];
  }
}

/** The state root: the configured external directory, else the coordinator's `var/`. */
export function stateRoot(layout: Layout): string {
  const configured = configuredStateRoot(layout);
  if (configured === null) {
    return layout.varDir;
  }
  if (!isAbsolute(configured) || configured.includes("\0")) {
    throw new StateRootError("invalid-state-root-config");
  }
  const target = canonical(configured);
  const sources = [
    layout.root,
    ...Object.values(layout.config.games).map((game) => resolve(layout.root, game.path)),
    ...Object.values(layout.config.kits).map((kit) => resolve(layout.root, kit.path)),
    ...registeredWorktrees(layout),
  ].map(canonical);
  if (
    sources.some((source) => contains(source, target) || contains(target, source)) ||
    hasGitAncestor(target)
  ) {
    throw new StateRootError("state-root-excluded");
  }
  return target;
}
