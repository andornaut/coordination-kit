// CLI entry, usage and coordinator root resolution.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { execute, impl } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      out.push(path);
      try {
        walk(path);
      } catch {
        // Not a directory.
      }
    }
  };
  walk(root);
  return out;
}

suite("entry", () => {
  const workspace = workspaces();

  contract("help requires no configuration, state or runtime writes", async () => {
    const ws = workspace();
    // Build command lines first: adapters may prepare scratch support files.
    const commands = ["--help", "help"].map((word) => impl.help(ws, word));
    const before = tree(ws.root);
    for (const command of commands) {
      const result = await execute(command);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("usage: coordination-kit COMMAND");
      expect(result.stdout).toContain("--parent UUID");
      expect(result.stdout).toContain("work check");
      expect(result.stdout).not.toContain("check-config");
      expect(result.stderr).toBe("");
    }
    expect(tree(ws.root)).toEqual(before);
    for (const command of [
      impl.bare(ws, ["invalid"]),
      impl.bare(ws, ["run", "--game", ws.game]),
      impl.command(ws, ["invalid", "verb"]),
    ]) {
      const result = await execute(command);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("usage:");
    }
  });

  contract(
    "the coordinator root is --root, then COORDINATION_KIT_ROOT, then DELIVERY_KIT_ROOT",
    async () => {
      const ws = workspace();
      const status = ["message", "status", "--recipient", "game-coordinator"];
      const ok = impl.command(ws, ["harness", "ready"]);
      const run = (env: Record<string, string>, extra: string[] = []) =>
        execute({
          ...ok,
          argv: [process.execPath, ok.argv[1]!, ...status, ...extra],
          cwd: ws.root,
          env,
        });
      const base = ws.baseEnv();
      const absent = join(ws.root, "absent");
      expect((await run({ ...base, COORDINATION_KIT_ROOT: ws.coordinator })).code).toBe(0);
      expect((await run({ ...base, DELIVERY_KIT_ROOT: ws.coordinator })).code).toBe(0);
      expect(
        (await run({ ...base, COORDINATION_KIT_ROOT: absent, DELIVERY_KIT_ROOT: ws.coordinator }))
          .code,
      ).not.toBe(0);
      expect(
        (await run({ ...base, COORDINATION_KIT_ROOT: absent }, ["--root", ws.coordinator])).code,
      ).toBe(0);
    },
  );
});
