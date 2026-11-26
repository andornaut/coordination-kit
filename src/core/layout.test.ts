import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appLayout,
  appRoleKeys,
  gameLayout,
  loadLayout,
  roleKeys,
  UnknownApp,
  UnknownGame,
  validateWorkspaceConfig,
} from "./layout.ts";
import { coordinatorConfig, makeFixture, writeFixtureJson } from "./testFixtures.ts";
import { ValidationError } from "./validate.ts";

describe("loadLayout", () => {
  it("resolves var/ and per-game paths relative to game-coordinator", () => {
    const { base, root } = makeFixture();
    const layout = loadLayout(root);
    expect(layout.mode).toBe("legacy");
    expect(layout.reviewDir).toBe(join(root, "var/game-dev"));
    expect(layout.registryFile).toBe(join(root, "var/registry.json"));
    expect(layout.registryLock).toBe(join(root, "var/registry.lock"));
    expect(layout.routeFile).toBe(join(root, "var/route.json"));
    const game = gameLayout(layout, "archies-dog-walks");
    expect(game.repo).toBe(join(base, "archies-dog-walks"));
    expect(game.configFile).toBe(join(base, "archies-dog-walks/delivery-kit.json"));
    expect(game.busDir).toBe(join(root, "var/games/archies-dog-walks/bus"));
    expect(() => gameLayout(layout, "unknown")).toThrow(UnknownGame);
    expect(roleKeys(layout.config)).toContain("chibis-way-home/tech");
    expect(roleKeys(layout.config)).toContain("game-coordinator");
    expect(appRoleKeys(layout.config, "archies-dog-walks")).toEqual([
      "archies-dog-walks/art",
      "archies-dog-walks/gameplay",
      "archies-dog-walks/tech",
    ]);
    expect(layout.config.games["archies-dog-walks"]?.roles).toEqual(["art", "gameplay", "tech"]);
    expect(JSON.parse(JSON.stringify(layout.config))).toEqual(coordinatorConfig());
    expect(validateWorkspaceConfig(layout.config)).toEqual(layout.config);
  });

  it("accepts an empty wake minute list, which schedules no review", () => {
    const { root } = makeFixture();
    writeFixtureJson(join(root, "config.json"), { ...coordinatorConfig(), wakeMinutes: [] });
    expect(loadLayout(root).config.wakeMinutes).toEqual([]);
  });

  it("rejects absolute paths, invalid IDs and unknown keys", () => {
    const { root } = makeFixture();
    const config = coordinatorConfig();
    (config.games as Record<string, Record<string, unknown>>).Bad_ID = {
      name: "Bad",
      path: "/abs",
      roles: ["tech"],
    };
    config.extra = true;
    writeFixtureJson(join(root, "config.json"), config);
    try {
      loadLayout(root);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issues = (error as ValidationError).issues.join("\n");
      expect(issues).toContain("/games/Bad_ID: game ID must match");
      expect(issues).toContain("/games/Bad_ID/path: must be a relative path");
      expect(issues).toContain("/extra: unknown key");
    }
  });
});

const appConfig = {
  apps: { dashboard: { name: "Dashboard", path: "../dashboard", roles: ["operator"] } },
  kits: {},
  permissions: { operator: { apps: { dashboard: ["delivery:operate"] }, workspace: [] } },
  schema: 1,
  sharedRoles: [],
  timezone: "UTC",
  wakeMinutes: [],
} as const;

describe("app workspace layout", () => {
  it("loads an arbitrary operator key and fresh app and review paths", () => {
    const { base, root } = makeFixture();
    writeFixtureJson(join(root, "config.json"), appConfig);
    const layout = loadLayout(root);
    const app = appLayout(layout, "dashboard");
    expect(layout.mode).toBe("app");
    expect(layout.config.apps.dashboard).toEqual(appConfig.apps.dashboard);
    expect(layout.config.games.dashboard).toEqual(appConfig.apps.dashboard);
    expect(layout.config.permissions).toEqual(appConfig.permissions);
    expect(roleKeys(layout.config)).toEqual(["operator"]);
    expect(layout.reviewDir).toBe(join(root, "var/reviews"));
    expect(app).toEqual({
      appId: "dashboard",
      busDir: join(root, "var/apps/dashboard/bus"),
      configFile: join(base, "dashboard/delivery-kit.json"),
      id: "dashboard",
      name: "Dashboard",
      repo: join(base, "dashboard"),
      stateDir: join(root, "var/apps/dashboard"),
    });
    expect(gameLayout(layout, "dashboard").busDir).toBe(app.busDir);
    expect(() => appLayout(layout, "constructor")).toThrow(UnknownApp);
    expect(JSON.parse(JSON.stringify(layout.config))).toEqual(appConfig);
    expect(validateWorkspaceConfig(layout.config)).toEqual(layout.config);
  });

  it("keeps a migrated app's previous bus, review and registry paths and exact role keys", () => {
    const { root } = makeFixture();
    const old = loadLayout(root);
    const id = "archies-dog-walks";
    const game = gameLayout(old, id);
    writeFixtureJson(old.configFile, {
      ...appConfig,
      appStateDir: "games",
      apps: old.config.apps,
      permissions: {},
      sharedRoles: old.config.sharedRoles,
    });
    const current = loadLayout(root);
    expect(current.mode).toBe("app");
    expect(appLayout(current, id)).toEqual({ ...game, appId: id });
    expect(current.reviewDir).toBe(old.reviewDir);
    expect(current.registryFile).toBe(old.registryFile);
    expect(current.routeFile).toBe(old.routeFile);
    expect(roleKeys(current.config)).toEqual(roleKeys(old.config));
  });

  it("rejects ambiguous maps, absent or invalid grants, and app state paths outside var", () => {
    expect(() => validateWorkspaceConfig({ ...appConfig, games: {} })).toThrow(
      "/: specify exactly one of apps or games",
    );
    expect(() => validateWorkspaceConfig({ ...appConfig, permissions: undefined })).toThrow(
      "/permissions: must be an object",
    );
    expect(() =>
      validateWorkspaceConfig({
        ...appConfig,
        appStateDir: "../other",
        permissions: {
          outsider: { apps: {}, workspace: [] },
          operator: {
            apps: { dashboard: ["grant:anything"], nonexistent: ["review:deliver"] },
            workspace: ["registry:manage", "registry:manage"],
          },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.stringContaining("/appStateDir: must be one of"),
          "/permissions/outsider: must name a configured role",
          "/permissions/operator/workspace: must not contain duplicates",
          expect.stringContaining("/permissions/operator/apps/dashboard/0: must be one of"),
          "/permissions/operator/apps/nonexistent: must name a configured app",
        ]),
      }),
    );
  });
});
