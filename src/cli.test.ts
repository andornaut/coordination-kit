import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "./cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "./core/cli/io.ts";
import { VERSION } from "./core/cli/version.ts";
import { loadLayout } from "./core/configuration/layout.ts";
import { makeFixture, registryInput, TEST_CLOCK } from "./core/testFixtures.ts";
import { createRegistry, type Registry } from "./registry/index.ts";

async function dispatch(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: "/nonexistent", env: {}, err: (text) => (err += text), out: (text) => (out += text) },
    argv,
  );
  return { code, err, out };
}

function run(root: string, ...argv: string[]) {
  return dispatch(...argv, "--root", root);
}

function withRegistry(root: string): void {
  createRegistry(
    TEST_CLOCK,
    loadLayout(root),
    registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">,
  );
}

describe("dispatcher", () => {
  it("prints usage for help and rejects unknown commands", async () => {
    const { root } = makeFixture();
    const help = await run(root, "--help");
    expect(help.code).toBe(EXIT_OK);
    expect(help.out).toContain("store retire [--dry-run]");
    expect(help.out).toContain("request close --id SAFE_ID --reason TEXT [--work WORK_ID]");
    expect(help.out).not.toContain("reminder");
    expect(help.out).not.toContain("decision marker");
    expect(help.out).not.toContain("decision resolve");
    expect(help.out).not.toContain("--game");
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

  it("preserves global help and version output with a trailing root", async () => {
    const root = "/nonexistent";
    const help = await run(root, "help");
    expect(help.code).toBe(EXIT_OK);
    expect(await run(root, "--help")).toEqual(help);
    expect(await run(root, "--version")).toEqual({ code: EXIT_OK, out: `${VERSION}\n`, err: "" });
    const json = await run(root, "--version", "--json");
    expect(json.code).toBe(EXIT_OK);
    expect(json.err).toBe("");
    expect(JSON.parse(json.out)).toEqual({
      schema: 1,
      version: VERSION,
      distSha256: "0".repeat(64),
    });
  });

  it("prints scoped help before reading configuration or running the command", async () => {
    const help = await run("/nonexistent", "msg", "send", "--help");
    expect(help).toMatchObject({ code: EXIT_OK, err: "" });
    expect(help.out).toContain("usage: coordination-kit msg send");
    expect(help.out).toContain("--to ROLE");
    expect(help.out).toContain("--root DIR");
    expect(help.out).not.toContain("harness doctor");
    const invalid = await Promise.all(
      [
        ["--help", "--help"],
        ["--help", "--unknown"],
        ["--", "--help"],
      ].map((rest) => run("/nonexistent", "msg", "send", ...rest)),
    );
    for (const result of invalid) {
      expect(result).toMatchObject({ code: EXIT_USAGE, out: "" });
    }
  });

  it("accepts one root in either form and leaves tokens after -- for the command", async () => {
    const { root } = makeFixture();
    const separated = await run(root, "status");
    expect(await dispatch(`--root=${root}`, "status")).toEqual(separated);
    expect(await dispatch("status", `--root=${root}`)).toEqual(separated);
    expect(await run(root, "--version", "--root=/other")).toMatchObject({
      code: EXIT_USAGE,
      err: expect.stringContaining("--root is given more than once"),
      out: "",
    });
    expect(await dispatch("--version", "--root=")).toMatchObject({
      code: EXIT_USAGE,
      err: expect.stringContaining("--root needs a directory"),
      out: "",
    });
    expect(await dispatch("work", "check", "--", "--root", root)).toMatchObject({
      code: EXIT_USAGE,
      err: expect.stringContaining("usage: coordination-kit work check"),
      out: "",
    });
  });

  it.each([
    { argv: ["help", "--typo"] },
    { argv: ["--help", "--help"] },
    { argv: ["--help", "--version"] },
    { argv: ["--version", "--typo"] },
    { argv: ["--version", "--version"] },
    { argv: ["--version", "--json", "--json"] },
    { argv: ["--version", "--json", "extra"] },
  ])("rejects invalid global arguments $argv", async ({ argv }) => {
    const result = await run("/nonexistent", ...argv);
    expect(result).toMatchObject({ code: EXIT_USAGE, out: "" });
    expect(result.err).toContain("usage: coordination-kit");
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
