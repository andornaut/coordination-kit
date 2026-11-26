// Committed configuration and ignored state paths for a coordinator or standalone Git project.
import { resolve } from "node:path";

import { readJson, readJsonIfExists } from "./durable.ts";
import {
  STANDALONE_CONFIG_FILE,
  STANDALONE_STATE_DIR,
  type StandaloneConfig,
  validateStandaloneConfig,
} from "./standalone.ts";
import {
  checkArray,
  checkInteger,
  checkMap,
  checkName,
  checkObject,
  checkRelativePath,
  checkTimezone,
  ID_PATTERN,
  Issues,
  type Json,
} from "./validate.ts";

export interface GameEntry {
  /** Display name used in reports, for example "Archie". */
  readonly name: string;
  /** Repository path relative to game-coordinator. */
  readonly path: string;
  readonly roles: readonly string[];
}

export interface KitEntry {
  readonly path: string;
}

export interface GameCoordinatorConfig {
  readonly schema: 1;
  readonly timezone: string;
  readonly wakeMinutes: readonly number[];
  readonly games: Readonly<Record<string, GameEntry>>;
  readonly kits: Readonly<Record<string, KitEntry>>;
  readonly sharedRoles: readonly string[];
}

export interface Layout {
  /** Absolute coordination root. */
  readonly root: string;
  readonly config: GameCoordinatorConfig;
  readonly configFile: string;
  readonly varDir: string;
  readonly registryFile: string;
  readonly registryLock: string;
  readonly routeFile: string;
  readonly handoffsDir: string;
  /** Review and inbox state: snapshots, health history, acknowledgements and retentions. */
  readonly reviewDir: string;
  readonly project?: StandaloneConfig;
}

export interface GameLayout {
  readonly id: string;
  readonly name: string;
  /** Absolute game repository. */
  readonly repo: string;
  /** The game's committed delivery-kit.json. */
  readonly configFile: string;
  /** var/games/<g>/ */
  readonly stateDir: string;
  /** var/games/<g>/bus/: the bus state directory; delivery-kit names its runner files there. */
  readonly busDir: string;
}

export const CONFIG_FILE = "config.json";
export const PROJECT_CONFIG_FILE = "delivery-kit.json";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

function checkGames(issues: Issues, value: unknown): void {
  if (!checkMap(issues, "/games", value)) {
    return;
  }
  for (const [id, entry] of Object.entries(value)) {
    const at = `/games/${id}`;
    if (!ID_PATTERN.test(id)) {
      issues.add(at, `game ID must match ${String(ID_PATTERN)}`);
    }
    if (checkObject(issues, at, { required: ["name", "path", "roles"] }, entry)) {
      checkName(issues, `${at}/name`, NAME_PATTERN, entry.name);
      checkRelativePath(issues, `${at}/path`, entry.path);
      if (checkArray(issues, `${at}/roles`, { nonEmpty: true, unique: true }, entry.roles)) {
        entry.roles.forEach((role, index) =>
          checkName(issues, `${at}/roles/${index}`, ID_PATTERN, role),
        );
      }
    }
  }
}

function checkKits(issues: Issues, value: unknown): void {
  if (!checkMap(issues, "/kits", value)) {
    return;
  }
  for (const [id, entry] of Object.entries(value)) {
    const at = `/kits/${id}`;
    if (!ID_PATTERN.test(id)) {
      issues.add(at, `kit ID must match ${String(ID_PATTERN)}`);
    }
    if (checkObject(issues, at, { required: ["path"] }, entry)) {
      checkRelativePath(issues, `${at}/path`, entry.path);
    }
  }
}

export function validateGameCoordinatorConfig(value: unknown): GameCoordinatorConfig {
  const issues = new Issues();
  const shape = { required: ["schema", "timezone", "wakeMinutes", "games", "kits", "sharedRoles"] };
  if (checkObject(issues, "", shape, value)) {
    const config: Json = value;
    if (config.schema !== 1) {
      issues.add("/schema", "must be 1");
    }
    checkTimezone(issues, "/timezone", config.timezone);
    // An empty list schedules no review.
    if (checkArray(issues, "/wakeMinutes", { unique: true }, config.wakeMinutes)) {
      config.wakeMinutes.forEach((minute, index) =>
        checkInteger(issues, `/wakeMinutes/${index}`, { max: 59, min: 0 }, minute),
      );
    }
    checkGames(issues, config.games);
    checkKits(issues, config.kits);
    if (checkArray(issues, "/sharedRoles", { unique: true }, config.sharedRoles)) {
      config.sharedRoles.forEach((role, index) =>
        checkName(issues, `/sharedRoles/${index}`, ID_PATTERN, role),
      );
    }
  }
  issues.throwIfAny(CONFIG_FILE);
  return value as unknown as GameCoordinatorConfig;
}

export function loadLayout(coordinatorRoot: string): Layout {
  const root = resolve(coordinatorRoot);
  const standaloneFile = resolve(root, STANDALONE_CONFIG_FILE);
  const source = readJsonIfExists(standaloneFile);
  const project = source === undefined ? undefined : validateStandaloneConfig(source);
  const configFile = project === undefined ? resolve(root, CONFIG_FILE) : standaloneFile;
  const config: GameCoordinatorConfig =
    project === undefined
      ? validateGameCoordinatorConfig(readJson(configFile))
      : {
          games: {},
          kits: {},
          schema: 1,
          sharedRoles: project.project.roles,
          timezone: "UTC",
          wakeMinutes: [],
        };
  const varDir = resolve(root, project === undefined ? "var" : STANDALONE_STATE_DIR);
  return {
    config,
    configFile,
    handoffsDir: resolve(varDir, "handoffs"),
    ...(project === undefined ? {} : { project }),
    registryFile: resolve(varDir, "registry.json"),
    registryLock: resolve(varDir, "registry.lock"),
    // CLEANUP (added 2026-11-13): Retain persisted review/inbox state until an approved state migration.
    reviewDir: resolve(varDir, "game-dev"),
    root,
    routeFile: resolve(varDir, "route.json"),
    varDir,
  };
}

export class UnknownGame extends Error {
  readonly game: string;

  constructor(game: string) {
    super(`unknown game: ${game}`);
    this.name = "UnknownGame";
    this.game = game;
  }
}

export function gameLayout(layout: Layout, game: string): GameLayout {
  const entry = Object.hasOwn(layout.config.games, game) ? layout.config.games[game] : undefined;
  if (entry === undefined) {
    throw new UnknownGame(game);
  }
  const repo = resolve(layout.root, entry.path);
  const stateDir = resolve(layout.varDir, "games", game);
  const busDir = resolve(stateDir, "bus");
  return {
    busDir,
    configFile: resolve(repo, PROJECT_CONFIG_FILE),
    id: game,
    name: entry.name,
    repo,
    stateDir,
  };
}

/** Every valid registry role key: `<game>/<role>` for each game role, then each shared role. */
export function roleKeys(config: GameCoordinatorConfig): string[] {
  const keys = Object.entries(config.games).flatMap(([game, entry]) =>
    entry.roles.map((role) => `${game}/${role}`),
  );
  return [...keys, ...config.sharedRoles];
}
