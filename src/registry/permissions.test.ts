import { describe, expect, it } from "vitest";

import { loadLayout } from "../core/layout.ts";
import {
  CLAUDE_COORDINATOR,
  CLAUDE_TECH,
  makeFixture,
  registryInput,
  TEST_CLOCK,
  writeFixtureJson,
} from "../core/testFixtures.ts";
import { isPermitted } from "./permissions.ts";
import type { Registry } from "./schema.ts";
import { createRegistry } from "./store.ts";

describe("workspace permissions", () => {
  it("uses configured roles and scopes with the current active binding", () => {
    const { root } = makeFixture();
    const original = loadLayout(root);
    writeFixtureJson(original.configFile, {
      apps: {
        alpha: { name: "Alpha", path: "../alpha", roles: ["operator"] },
        beta: { name: "Beta", path: "../beta", roles: ["beta-owner"] },
      },
      kits: {},
      permissions: {
        operator: { apps: { alpha: ["events:ingest"] }, workspace: ["store:maintain"] },
      },
      schema: 1,
      sharedRoles: ["game-coordinator"],
      timezone: "UTC",
      wakeMinutes: [],
    });
    const layout = loadLayout(root);
    const operator = { nativeId: CLAUDE_TECH, role: "operator" };
    const oldLabel = { nativeId: CLAUDE_COORDINATOR, role: "game-coordinator" };
    const registry = createRegistry(TEST_CLOCK, layout, {
      ...registryInput(),
      operations: {},
      roles: Object.fromEntries(
        [operator, oldLabel].map(({ nativeId, role }) => [
          role,
          { conversations: { claude: nativeId }, ownership: "active", worktree: "." },
        ]),
      ),
    } as Omit<Registry, "revision" | "updatedAt">);
    expect(isPermitted(layout, registry, operator, "events:ingest", "alpha")).toBe(true);
    expect(isPermitted(layout, registry, operator, "events:ingest", "beta")).toBe(false);
    expect(isPermitted(layout, registry, operator, "events:ingest")).toBe(false);
    expect(isPermitted(layout, registry, operator, "store:maintain")).toBe(true);
    expect(isPermitted(layout, registry, oldLabel, "store:maintain")).toBe(false);
    expect(
      isPermitted(layout, registry, { ...operator, nativeId: oldLabel.nativeId }, "store:maintain"),
    ).toBe(false);
    expect(isPermitted(layout, registry, { ...operator, worker: "worker" }, "store:maintain")).toBe(
      false,
    );
    const held = {
      ...registry,
      roles: { ...registry.roles, operator: { ...registry.roles.operator!, phase: "source-held" } },
    };
    expect(isPermitted(layout, held, operator, "store:maintain")).toBe(false);
  });
});
