import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { gameLayout, type Layout, loadLayout } from "../../core/layout.ts";
import {
  makeFixture,
  projectConfig,
  registryInput,
  writeFixtureJson,
} from "../../core/testFixtures.ts";
import { createRegistry, type Registry, updateRegistry } from "../../registry/index.ts";
import { readRoleRoute, RouteError, routeRecipient } from "./route.ts";

const CODEX_COORDINATOR = "00000000-0000-4000-8000-000000000004";

function setup(route: unknown): Layout {
  const layout = loadLayout(makeFixture().root);
  const input = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
  createRegistry(layout, input);
  updateRegistry(layout, 1, (draft) => {
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
