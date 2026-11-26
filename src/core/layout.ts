// Committed configuration and ignored state paths for a workspace or standalone Git project.
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
  checkEnum,
  checkInteger,
  checkMap,
  checkName,
  checkObject,
  checkRelativePath,
  checkTimezone,
  ID_PATTERN,
  isObject,
  Issues,
  type Json,
} from "./validate.ts";

export interface AppEntry {
  /** Display name used in reports. */
  readonly name: string;
  /** Repository path relative to the workspace. */
  readonly path: string;
  readonly roles: readonly string[];
}

export type GameEntry = AppEntry;

export interface KitEntry {
  readonly path: string;
}

export const PERMISSIONS = [
  "store:maintain",
  "policy:manage",
  "handoff:manage",
  "messages:read-all",
  "review:deliver",
  "events:ingest",
  "delivery:operate",
  "registry:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface RolePermissions {
  readonly workspace: readonly Permission[];
  readonly apps: Readonly<Record<string, readonly Permission[]>>;
}

export interface GameCoordinatorConfig {
  readonly schema: 1;
  readonly timezone: string;
  readonly wakeMinutes: readonly number[];
  readonly games: Readonly<Record<string, GameEntry>>;
  readonly apps?: Readonly<Record<string, AppEntry>>;
  readonly appStateDir?: "apps" | "games";
  readonly permissions?: Readonly<Record<string, RolePermissions>>;
  readonly kits: Readonly<Record<string, KitEntry>>;
  readonly sharedRoles: readonly string[];
}

export interface WorkspaceConfig extends GameCoordinatorConfig {
  /** Canonical app entries use exact registry role keys. */
  readonly apps: Readonly<Record<string, AppEntry>>;
}

export interface Layout {
  /** Absolute workspace root. */
  readonly root: string;
  readonly config: WorkspaceConfig;
  readonly mode: "legacy" | "app" | "standalone";
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
  /** Absolute app repository. */
  readonly repo: string;
  /** The app's committed delivery-kit.json. */
  readonly configFile: string;
  /** The app's runtime state. */
  readonly stateDir: string;
  /** The bus state directory; delivery-kit names its runner files there. */
  readonly busDir: string;
}

export interface AppLayout extends GameLayout {
  readonly appId: string;
}

export const CONFIG_FILE = "config.json";
export const PROJECT_CONFIG_FILE = "delivery-kit.json";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
export const ROLE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}(?:\/[a-z0-9][a-z0-9-]{0,63})?$/;

function checkApps(issues: Issues, key: "apps" | "games", value: unknown): void {
  if (!checkMap(issues, `/${key}`, value)) {
    return;
  }
  for (const [id, entry] of Object.entries(value)) {
    const at = `/${key}/${id}`;
    if (!ID_PATTERN.test(id)) {
      const label = key === "games" ? "game" : "app";
      issues.add(at, `${label} ID must match ${String(ID_PATTERN)}`);
    }
    if (checkObject(issues, at, { required: ["name", "path", "roles"] }, entry)) {
      checkName(issues, `${at}/name`, NAME_PATTERN, entry.name);
      checkRelativePath(issues, `${at}/path`, entry.path);
      if (checkArray(issues, `${at}/roles`, { nonEmpty: true, unique: true }, entry.roles)) {
        entry.roles.forEach((role, index) =>
          checkName(
            issues,
            `${at}/roles/${index}`,
            key === "games" ? ID_PATTERN : ROLE_KEY_PATTERN,
            role,
          ),
        );
      }
    }
  }
}

function checkPermissions(issues: Issues, config: Json): void {
  const value = config.permissions;
  if (!checkMap(issues, "/permissions", value)) {
    return;
  }
  const apps = isObject(config.apps) ? config.apps : {};
  const roles = new Set<unknown>(Array.isArray(config.sharedRoles) ? config.sharedRoles : []);
  for (const entry of Object.values(apps)) {
    if (isObject(entry) && Array.isArray(entry.roles)) {
      entry.roles.forEach((role: unknown) => roles.add(role));
    }
  }
  const checkGrants = (at: string, grants: unknown) => {
    if (checkArray(issues, at, { unique: true }, grants)) {
      grants.forEach((grant, index) => checkEnum(issues, `${at}/${index}`, PERMISSIONS, grant));
    }
  };
  for (const [role, scope] of Object.entries(value)) {
    const at = `/permissions/${role}`;
    if (!ROLE_KEY_PATTERN.test(role) || !roles.has(role)) {
      issues.add(at, "must name a configured role");
    }
    if (!checkObject(issues, at, { required: ["workspace", "apps"] }, scope)) {
      continue;
    }
    checkGrants(`${at}/workspace`, scope.workspace);
    if (checkMap(issues, `${at}/apps`, scope.apps)) {
      for (const [id, grants] of Object.entries(scope.apps)) {
        const appAt = `${at}/apps/${id}`;
        if (!Object.hasOwn(apps, id)) {
          issues.add(appAt, "must name a configured app");
        }
        checkGrants(appAt, grants);
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

function configuresApps(config: object): boolean {
  return Object.prototype.propertyIsEnumerable.call(config, "apps");
}

function normalizedConfig(config: GameCoordinatorConfig): WorkspaceConfig {
  // Keep compatibility views out of JSON so a serialized config still declares exactly one map.
  if (!configuresApps(config)) {
    const apps = Object.fromEntries(
      Object.entries(config.games).map(([id, entry]) => [
        id,
        { ...entry, roles: entry.roles.map((role) => `${id}/${role}`) },
      ]),
    );
    return Object.defineProperty({ ...config }, "apps", { value: apps }) as WorkspaceConfig;
  }
  return Object.defineProperty({ ...config }, "games", { value: config.apps }) as WorkspaceConfig;
}

export function validateWorkspaceConfig(value: unknown): WorkspaceConfig {
  const issues = new Issues();
  const shape = {
    optional: ["apps", "games", "appStateDir", "permissions"],
    required: ["schema", "timezone", "wakeMinutes", "kits", "sharedRoles"],
  };
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
    const appMode = configuresApps(config);
    if (appMode === Object.prototype.propertyIsEnumerable.call(config, "games")) {
      issues.add("/", "specify exactly one of apps or games");
    }
    if (appMode) {
      checkApps(issues, "apps", config.apps);
      if (config.appStateDir !== undefined) {
        checkEnum(issues, "/appStateDir", ["apps", "games"], config.appStateDir);
      }
      checkPermissions(issues, config);
    } else {
      checkApps(issues, "games", config.games);
      for (const option of ["appStateDir", "permissions"] as const) {
        if (Object.hasOwn(config, option)) {
          issues.add(`/${option}`, "is supported with apps");
        }
      }
    }
    checkKits(issues, config.kits);
    if (checkArray(issues, "/sharedRoles", { unique: true }, config.sharedRoles)) {
      config.sharedRoles.forEach((role, index) =>
        checkName(issues, `/sharedRoles/${index}`, ID_PATTERN, role),
      );
    }
  }
  issues.throwIfAny(CONFIG_FILE);
  return normalizedConfig(value as GameCoordinatorConfig);
}

export const validateGameCoordinatorConfig = validateWorkspaceConfig;

export function loadLayout(workspaceRoot: string): Layout {
  const root = resolve(workspaceRoot);
  const standaloneFile = resolve(root, STANDALONE_CONFIG_FILE);
  const source = readJsonIfExists(standaloneFile);
  const project = source === undefined ? undefined : validateStandaloneConfig(source);
  const configFile = project === undefined ? resolve(root, CONFIG_FILE) : standaloneFile;
  const config =
    project === undefined
      ? validateWorkspaceConfig(readJson(configFile))
      : normalizedConfig({
          games: {},
          kits: {},
          schema: 1,
          sharedRoles: project.project.roles,
          timezone: "UTC",
          wakeMinutes: [],
        });
  const mode = project === undefined ? (configuresApps(config) ? "app" : "legacy") : "standalone";
  const varDir = resolve(root, project === undefined ? "var" : STANDALONE_STATE_DIR);
  return {
    config,
    configFile,
    handoffsDir: resolve(varDir, "handoffs"),
    mode,
    ...(project === undefined ? {} : { project }),
    registryFile: resolve(varDir, "registry.json"),
    registryLock: resolve(varDir, "registry.lock"),
    reviewDir: resolve(
      varDir,
      mode === "app" && config.appStateDir !== "games" ? "reviews" : "game-dev",
    ),
    root,
    routeFile: resolve(varDir, "route.json"),
    varDir,
  };
}

export class UnknownApp extends Error {
  readonly appId: string;

  constructor(appId: string) {
    super(`unknown app: ${appId}`);
    this.name = "UnknownApp";
    this.appId = appId;
  }
}

export class UnknownGame extends Error {
  readonly game: string;

  constructor(game: string) {
    super(`unknown game: ${game}`);
    this.name = "UnknownGame";
    this.game = game;
  }
}

function layoutForEntry(layout: Layout, appId: string, entry: AppEntry): GameLayout {
  const repo = resolve(layout.root, entry.path);
  const stateDir = resolve(
    layout.varDir,
    layout.mode === "app" ? (layout.config.appStateDir ?? "apps") : "games",
    appId,
  );
  const busDir = resolve(stateDir, "bus");
  return {
    busDir,
    configFile: resolve(repo, PROJECT_CONFIG_FILE),
    id: appId,
    name: entry.name,
    repo,
    stateDir,
  };
}

export function appLayout(layout: Layout, appId: string): AppLayout {
  if (!Object.hasOwn(layout.config.apps, appId)) {
    throw new UnknownApp(appId);
  }
  return { ...layoutForEntry(layout, appId, layout.config.apps[appId]!), appId };
}

export function gameLayout(layout: Layout, game: string): GameLayout {
  if (!Object.hasOwn(layout.config.games, game)) {
    throw new UnknownGame(game);
  }
  return layoutForEntry(layout, game, layout.config.games[game]!);
}

/** Exact registry role keys for a configured app. */
export function appRoleKeys(config: GameCoordinatorConfig, app: string): readonly string[] {
  if (config.apps !== undefined) {
    return Object.hasOwn(config.apps, app) ? config.apps[app]!.roles : [];
  }
  return Object.hasOwn(config.games, app)
    ? config.games[app]!.roles.map((role) => `${app}/${role}`)
    : [];
}

/** Every valid registry role key in one workspace. */
export function roleKeys(config: GameCoordinatorConfig): string[] {
  const keys = Object.keys(config.apps ?? config.games).flatMap((id) => appRoleKeys(config, id));
  return [...new Set([...keys, ...config.sharedRoles])];
}
