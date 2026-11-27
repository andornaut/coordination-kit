import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appLayout, gameLayout, type Layout, loadLayout } from "../../core/configuration/layout.ts";
import {
  makeFixture,
  projectConfig,
  registryInput,
  TEST_CLOCK,
  writeFixtureJson,
} from "../../core/testFixtures.ts";
import { createRegistry, type Registry, updateRegistry } from "../../registry/index.ts";
import { readRoleRoute, RouteError, routeRecipient } from "./route.ts";

const CODEX_COORDINATOR = "00000000-0000-4000-8000-000000000004";

function setup(route: unknown): Layout {
  const layout = loadLayout(makeFixture().root);
  const input = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
  createRegistry(TEST_CLOCK, layout, input);
  updateRegistry(TEST_CLOCK, layout, 1, (draft) => {
    draft.roles["game-coordinator"]!.conversations.codex = CODEX_COORDINATOR;
  });
  writeFileSync(layout.routeFile, JSON.stringify(route));
  return layout;
}

const ROUTE = {
  host: "archies-dog-walks",
  schema: 2,
  state: "active",
  targets: ["archies-dog-walks/tech", "archies-dog-walks/art"],
};

describe("role-name route", () => {
  it("refuses every malformed route", () => {
    const changes: [string, Record<string, unknown>][] = [
      ["an unknown role", { targets: ["archies-dog-walks/qa"] }],
      ["an unknown host", { host: "other-game" }],
      ["duplicate targets", { targets: ["art-kit", "art-kit"] }],
      ["an active route without targets", { targets: [] }],
      ["another schema", { schema: 3 }],
      ["an unknown key", { recipient: "game-coordinator" }],
    ];
    for (const [name, change] of changes) {
      const layout = setup({ ...ROUTE, ...change });
      expect(() => readRoleRoute(layout), name).toThrow(RouteError);
    }
  });

  it("refuses an active route that targets its recipient", () => {
    const layout = setup({ ...ROUTE, targets: ["game-coordinator", "archies-dog-walks/tech"] });
    const route = readRoleRoute(layout)!;
    expect(() => routeRecipient(layout, route)).toThrow(
      "active route targets must not include the recipient game-coordinator",
    );
  });
});

describe("routeRecipient host configuration", () => {
  it("reads reports past an unknown deploy key and refuses malformed reports", () => {
    const layout = setup(ROUTE);
    const route = readRoleRoute(layout)!;
    const config = projectConfig("Archie");
    (config.deploy as Record<string, unknown>).futureSetting = true;
    const file = gameLayout(layout, ROUTE.host).configFile;
    writeFixtureJson(file, config);
    expect(routeRecipient(layout, route)).toBe("game-coordinator");
    (config.reports as Record<string, unknown>).workerParents = "game-coordinator";
    writeFixtureJson(file, config);
    expect(() => routeRecipient(layout, route)).toThrow(RouteError);
  });
});

describe("app review routes", () => {
  function appRoute(recipient: string): Layout {
    const { root } = makeFixture();
    writeFixtureJson(join(root, "config.json"), {
      apps: {
        "example-app": {
          name: "Example",
          path: "../archies-dog-walks",
          roles: ["operator"],
        },
        "another-app": {
          name: "Another",
          path: "../chibis-way-home",
          roles: ["auditor"],
        },
      },
      kits: {},
      permissions: {},
      schema: 1,
      sharedRoles: ["workspace-reviewer"],
      timezone: "UTC",
      wakeMinutes: [30],
    });
    const layout = loadLayout(root);
    const app = appLayout(layout, "example-app");
    writeFixtureJson(app.configFile, {
      ...projectConfig("Example"),
      reports: { project: "Example", recipient, scheduledTicks: true, workerParents: ["operator"] },
    });
    mkdirSync(layout.varDir, { recursive: true });
    writeFixtureJson(layout.routeFile, {
      host: app.id,
      schema: 2,
      state: "active",
      targets: [],
    });
    return layout;
  }

  it("runs an active route for a single app role without additional targets", () => {
    const layout = appRoute("operator");
    const route = readRoleRoute(layout)!;
    expect(route.targets).toEqual([]);
    expect(routeRecipient(layout, route)).toBe("operator");
  });

  it("refuses a configured recipient from another app", () => {
    const layout = appRoute("auditor");
    const route = readRoleRoute(layout)!;
    expect(() => routeRecipient(layout, route)).toThrow(
      "the route recipient auditor is not a role in app example-app or sharedRoles",
    );
  });

  it("accepts an explicitly shared workspace recipient", () => {
    const layout = appRoute("workspace-reviewer");
    expect(routeRecipient(layout, readRoleRoute(layout)!)).toBe("workspace-reviewer");
  });
});
