import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, main } from "./cli.ts";
import { loadLayout } from "./core/layout.ts";
import { makeFixture, registryInput } from "./core/testFixtures.ts";
import { createRegistry, type Registry } from "./registry/index.ts";

async function run(
  root: string,
  ...argv: string[]
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: "/nonexistent", env: {}, err: (text) => (err += text), out: (text) => (out += text) },
    ["--root", root, ...argv],
  );
  return { code, err, out };
}

function withRegistry(root: string): void {
  createRegistry(
    loadLayout(root),
    registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">,
  );
}

describe("dispatcher", () => {
  it("prints usage for help and rejects unknown commands", async () => {
    const { root } = makeFixture();
    const help = await run(root, "--help");
    expect(help.code).toBe(EXIT_OK);
    expect(help.out).toContain("store retire --dry-run");
    expect(help.out).toContain("request close --id SAFE_ID --reason TEXT [--work WORK_ID]");
    expect(help.out).not.toContain("reminder");
    expect(help.out).not.toContain("decision marker");
    expect(help.out).not.toContain("decision resolve");
    expect(help.out).toContain("harness doctor --game ID ... [--role ROLE ...]");
    expect(help.out).toContain("harness doctor --role ROLE ...");
    expect(help.out).not.toContain("harness doctor [");
    expect(help.out).toContain(
      "question open --title TEXT [--id SAFE_ID] [--work WORK_ID] [--option LABEL ...]",
    );
    expect(help.out).not.toContain("--options-file");
    expect(help.out).toContain("work check [--decisions]\n");
    expect(help.out).not.toContain("check-config");
    expect(await run(root, "scheduled-once")).toMatchObject({ code: EXIT_USAGE });
    expect(await run(root, "run", "--game", "archies-dog-walks")).toMatchObject({
      code: EXIT_USAGE,
    });
    expect((await run(root, "work", "check", "--unknown")).code).toBe(EXIT_USAGE);
  });
});

describe("retired commands", () => {
  it("rejects every removed protocol, ledger and legacy message command as unknown", async () => {
    const { root } = makeFixture();
    withRegistry(root);
    for (const argv of [
      ["protocol", "status"],
      ["protocol", "enroll-self"],
      ["ledger", "show"],
      ["message", "send"],
      ["message", "retire-spool"],
      ["inbox", "snapshot"],
      ["inbox", "ack"],
      ["events", "flush"],
      ["store", "cutover"],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await run(root, ...argv)).code, argv.join(" ")).toBe(EXIT_USAGE);
    }
  });
});

describe("claude ready and codex ready", () => {
  it("reports a missing registry or an unreadable layout as not ready, not as a usage error", async () => {
    const { base, root } = makeFixture();
    const absent = await run(root, "codex", "ready");
    expect(absent.code).toBe(EXIT_INVALID);
    expect(absent.out).toBe("");
    expect(absent.err).toMatch(/^coordination-kit: /);
    const missing = await run(join(base, "no-game-coordinator"), "claude", "ready");
    expect(missing.code).toBe(EXIT_INVALID);
    expect(missing.err).toMatch(/^coordination-kit: /);
    expect((await run(root, "claude", "ready", "--extra")).code).toBe(EXIT_USAGE);
  });
});

describe("coordinator root", () => {
  async function status(env: NodeJS.ProcessEnv, ...argv: string[]): Promise<number> {
    return main({ cwd: "/nonexistent", env, err: () => undefined, out: () => undefined }, [
      "question",
      "list",
      ...argv,
    ]);
  }

  it("takes --root, then COORDINATION_KIT_ROOT, then DELIVERY_KIT_ROOT", async () => {
    const { base, root } = makeFixture();
    withRegistry(root);
    const missing = join(base, "absent");
    expect(await status({ COORDINATION_KIT_ROOT: root })).toBe(EXIT_OK);
    expect(await status({ DELIVERY_KIT_ROOT: root })).toBe(EXIT_OK);
    expect(await status({ COORDINATION_KIT_ROOT: root, DELIVERY_KIT_ROOT: missing })).toBe(EXIT_OK);
    expect(await status({ COORDINATION_KIT_ROOT: missing, DELIVERY_KIT_ROOT: root })).not.toBe(
      EXIT_OK,
    );
    expect(await status({ COORDINATION_KIT_ROOT: "", DELIVERY_KIT_ROOT: root })).toBe(EXIT_OK);
    expect(await status({ COORDINATION_KIT_ROOT: missing }, "--root", root)).toBe(EXIT_OK);
    expect(await status({})).not.toBe(EXIT_OK);
  });
});
