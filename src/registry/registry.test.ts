import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type Layout, loadLayout, validateWorkspaceConfig } from "../core/configuration/layout.ts";
import { holdLock, LockBusy, LockError, lockIsFree } from "../core/files/lock.ts";
import {
  CLAUDE_COORDINATOR,
  clockAt,
  CODEX_TECH,
  makeFixture,
  registryInput,
  TEST_CLOCK,
} from "../core/testFixtures.ts";
import { ValidationError } from "../core/validate.ts";
import {
  createRegistry,
  readRegistry,
  type Registry,
  RegistryExists,
  RegistrySchema,
  resolveConversation,
  resolveHarness,
  RevisionConflict,
  updateRegistry,
} from "./index.ts";

const MODULE = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const NOW = clockAt("2026-11-04T03:00:00.000Z");

function setup(): Layout {
  const layout = loadLayout(makeFixture().root);
  createRegistry(
    NOW,
    layout,
    registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">,
  );
  return layout;
}

// A child process importing the TypeScript source directly; Node strips the types.
function childScript(body: string): string {
  return `import * as registry from ${JSON.stringify(MODULE)};\n${body}`;
}

function runChild(
  body: string,
  args: readonly string[],
): Promise<{ code: number | null; signal: string | null }> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript(body), ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("createRegistry and readRegistry", () => {
  it("creates revision 1 once and reads a validated snapshot", () => {
    const layout = setup();
    const registry = readRegistry(layout);
    expect(registry.revision).toBe(1);
    expect(registry.updatedAt).toBe("2026-11-04T03:00:00.000Z");
    expect(RegistrySchema.validate(layout.config, registry)).toEqual(registry);
    expect(() => createRegistry(TEST_CLOCK, layout, registry)).toThrow(RegistryExists);
  });
});

describe("app operations", () => {
  const config = validateWorkspaceConfig({
    apps: { dashboard: { name: "Dashboard", path: "../dashboard", roles: ["operator"] } },
    kits: {},
    permissions: { operator: { apps: { dashboard: ["delivery:operate"] }, workspace: [] } },
    schema: 1,
    sharedRoles: [],
    timezone: "UTC",
    wakeMinutes: [],
  });
  const operator = {
    conversations: { codex: CODEX_TECH },
    ownership: "active",
    worktree: "../dashboard",
  };
  const registry = {
    harness: "codex",
    host: { nativeProjectId: "project-1", root: "." },
    operations: { dashboard: { busOwner: "operator" } },
    revision: 1,
    roles: { operator },
    schema: 1,
    transfers: [],
    updatedAt: TEST_CLOCK().toISOString(),
  };

  it("accepts one operator registered under the exact configured role key", () => {
    expect(RegistrySchema.validate(config, registry)).toEqual(registry);
    expect(() =>
      RegistrySchema.validate(config, {
        ...registry,
        operations: { dashboard: { busOwner: "dashboard/operator" } },
        roles: { "dashboard/operator": operator },
      }),
    ).toThrow("/roles/dashboard/operator: is not a configured workspace role");
  });

  it("rejects unknown apps and unregistered bus owners without changing the operations format", () => {
    expect(() =>
      RegistrySchema.validate(config, {
        ...registry,
        operations: { unknown: { busOwner: "unregistered" } },
      }),
    ).toThrow(
      expect.objectContaining({
        issues: [
          "/operations/unknown: is not a configured workspace app",
          "/operations/unknown/busOwner: is not a registered role",
        ],
      }),
    );
    expect(() =>
      RegistrySchema.validate(undefined, { ...registry, operations: { Bad_ID: {} } }),
    ).toThrow("/operations/Bad_ID: app ID must match");
  });
});

describe("updateRegistry", () => {
  it("increments the revision, sets updatedAt and persists the mutation", () => {
    const layout = setup();
    const next = updateRegistry(clockAt("2026-11-04T04:00:00.000Z"), layout, 1, (draft) => {
      draft.operations["archies-dog-walks"]!.lastAdoption = {
        at: "2026-11-04T03:00:00Z",
        cliSha256: "a".repeat(64),
        version: "1.0.0",
      };
    });
    expect(next.revision).toBe(2);
    expect(next.updatedAt).toBe("2026-11-04T04:00:00.000Z");
    expect(readRegistry(layout)).toEqual(next);
  });

  it("rejects a stale revision with RevisionConflict and leaves the file unchanged", () => {
    const layout = setup();
    updateRegistry(TEST_CLOCK, layout, 1, () => undefined);
    const before = readFileSync(layout.registryFile);
    expect(() => updateRegistry(TEST_CLOCK, layout, 1, () => undefined)).toThrow(RevisionConflict);
    expect(readFileSync(layout.registryFile)).toEqual(before);
  });

  it("rejects an invalid result and leaves the file unchanged", () => {
    const layout = setup();
    const before = readFileSync(layout.registryFile);
    expect(() =>
      updateRegistry(TEST_CLOCK, layout, 1, (draft) => {
        draft.roles["game-coordinator"]!.worktree = "/absolute";
      }),
    ).toThrow(ValidationError);
    expect(readFileSync(layout.registryFile)).toEqual(before);
    expect(readdirSync(layout.varDir).sort()).toEqual(["registry.json", "registry.lock"]);
  });

  it("serializes concurrent writers in separate processes without losing an update", async () => {
    const layout = setup();
    const writers = 6;
    const rounds = 5;
    const body = `
const [root, id, rounds] = process.argv.slice(1);
const clock = () => new Date("2026-11-04T05:00:00.000Z");
const layout = registry.loadLayout(root);
for (let round = 0; round < Number(rounds); round += 1) {
  for (;;) {
    const current = registry.readRegistry(layout);
    try {
      registry.updateRegistry(clock, layout, current.revision, (draft) => {
        draft.transfers.push({ checkpoint: "var/handoffs/x.json", from: "codex", marker: \`w\${id}-\${round}\`,
          phase: "source-held", roles: ["game-coordinator"], to: "claude" });
      });
      break;
    } catch (error) {
      if (!(error instanceof registry.RevisionConflict)) throw error;
    }
  }
}`;
    const results = await Promise.all(
      Array.from({ length: writers }, (_, id) =>
        runChild(body, [layout.root, String(id), String(rounds)]),
      ),
    );
    expect(results.every((result) => result.code === 0)).toBe(true);
    const registry = readRegistry(layout);
    expect(registry.revision).toBe(1 + writers * rounds);
    expect(new Set(registry.transfers.map((transfer) => transfer.marker)).size).toBe(
      writers * rounds,
    );
  });

  it("keeps the previous registry when a writer dies between the synced write and the rename", async () => {
    const layout = setup();
    const before = readFileSync(layout.registryFile);
    const body = `
const layout = registry.loadLayout(process.argv[1]);
const clock = () => new Date("2026-11-04T05:00:00.000Z");
registry.updateRegistry(clock, layout, 1, (draft) => { draft.harness = "codex"; }, {
  onStage: (stage) => { if (stage === "synced") process.kill(process.pid, "SIGKILL"); },
});`;
    expect(await runChild(body, [layout.root])).toEqual({ code: null, signal: "SIGKILL" });
    expect(readFileSync(layout.registryFile)).toEqual(before);
    expect(readdirSync(layout.varDir).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
    expect(lockIsFree(layout.registryLock)).toBe(true);
    expect(updateRegistry(TEST_CLOCK, layout, 1, () => undefined).revision).toBe(2);
    expect(readdirSync(layout.varDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("writes under a registry lock the caller already holds", () => {
    const fixture = makeFixture();
    const layout = loadLayout(fixture.root);
    mkdirSync(layout.varDir, { recursive: true });
    const held = holdLock(layout.registryLock);
    try {
      const input = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
      // A second descriptor waits on the caller's own lock.
      expect(() => createRegistry(TEST_CLOCK, layout, input, { timeoutSeconds: 1 })).toThrow(
        LockBusy,
      );
      createRegistry(TEST_CLOCK, layout, input, { held, timeoutSeconds: 1 });
      const updated = updateRegistry(
        TEST_CLOCK,
        layout,
        1,
        (draft) => {
          draft.harness = "codex";
        },
        { held, timeoutSeconds: 1 },
      );
      expect(updated).toMatchObject({ harness: "codex", revision: 2 });
      expect(lockIsFree(layout.registryLock)).toBe(false);
    } finally {
      held.release();
    }
    expect(lockIsFree(layout.registryLock)).toBe(true);
  });

  it("rejects a held lock that is not var/registry.lock", () => {
    const layout = setup();
    const other = holdLock(join(layout.varDir, "other.lock"));
    try {
      expect(() =>
        updateRegistry(TEST_CLOCK, layout, 1, () => undefined, { held: other, timeoutSeconds: 1 }),
      ).toThrow(LockError);
      expect(readRegistry(layout).revision).toBe(1);
    } finally {
      other.release();
    }
  });
});

describe("role harness overrides", () => {
  it("uses the role's override while preserving the global default", () => {
    const layout = setup();
    const registry = updateRegistry(TEST_CLOCK, layout, 1, (draft) => {
      draft.roles["archies-dog-walks/tech"]!.harness = "codex";
    });
    expect(resolveHarness(registry, "archies-dog-walks/tech")).toBe("codex");
    expect(resolveHarness(registry, "game-coordinator")).toBe("claude");
    expect(resolveConversation(registry, "archies-dog-walks/tech")).toBe(CODEX_TECH);
    expect(registry.harness).toBe("claude");
  });

  it("returns null instead of an inactive provider's ID when the selected ID is missing", () => {
    const layout = setup();
    const registry = updateRegistry(TEST_CLOCK, layout, 1, (draft) => {
      draft.roles["game-coordinator"]!.harness = "codex";
    });
    expect(resolveConversation(registry, "game-coordinator")).toBeNull();
    expect(registry.roles["game-coordinator"]!.conversations.claude).toBe(CLAUDE_COORDINATOR);
  });
});
