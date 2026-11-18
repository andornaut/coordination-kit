import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, main } from "./cli.ts";
import { loadLayout } from "./layout.ts";
import { createRegistry, type Registry } from "./registry/index.ts";
import { makeFixture, registryInput } from "./testFixtures.ts";

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
    expect(help.out).toContain("message dispatch --id UUID");
    expect(help.out).toContain("message reconcile --id UUID --receipt");
    expect(help.out).toContain("message retire-spool --recipient ROLE|UUID [--dry-run]");
    expect(help.out).toContain("harness doctor --game ID ... [--role ROLE ...]");
    expect(help.out).toContain("harness doctor --role ROLE ...");
    expect(help.out).not.toContain("harness doctor [");
    expect(help.out).toContain("[--parent ROLE]");
    expect(help.out).toContain("message status --recipient ROLE [--include-body]");
    expect(help.out).toContain("work check\n");
    expect(help.out).not.toContain("check-config");
    expect(await run(root, "scheduled-once")).toMatchObject({ code: EXIT_USAGE });
    expect(await run(root, "run", "--game", "archies-dog-walks")).toMatchObject({
      code: EXIT_USAGE,
    });
    expect((await run(root, "work", "check", "--unknown")).code).toBe(EXIT_USAGE);
  });
});

describe("cross-directory common messages", () => {
  it("stores and pulls the exact body with root in different argument positions without native admission", async () => {
    const { base, root } = makeFixture();
    withRegistry(root);
    const body = "Exact original payload.\n\n";
    writeFileSync(join(base, "message.txt"), body);
    const id = "00000000-0000-4000-8000-000000000001";
    let out = "";
    let err = "";
    const io = {
      cwd: base,
      env: {},
      err: (text: string) => (err += text),
      out: (text: string) => (out += text),
    };
    expect(
      await main(io, [
        "message",
        "send",
        "--from",
        "game-coordinator",
        "--recipient",
        "archies-dog-walks/tech",
        "--root",
        root,
        "--id",
        id,
        "--body-file",
        "message.txt",
      ]),
    ).toBe(EXIT_OK);
    expect(JSON.parse(out)).toMatchObject({ id, state: "queued" });
    expect(JSON.parse(out)).not.toHaveProperty("body");
    out = "";
    expect(
      await main(io, ["message", "status", "--id", id, "--include-body", "--root", root]),
    ).toBe(EXIT_OK);
    expect(JSON.parse(out)).toMatchObject([{ id, body, state: "queued", attempts: 0 }]);
    expect(err).toBe("");
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
      "message",
      "status",
      "--recipient",
      "archies-dog-walks/tech",
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
    expect(await status({ COORDINATION_KIT_ROOT: missing }, "--root", root)).toBe(EXIT_OK);
    expect(await status({})).not.toBe(EXIT_OK);
  });
});
