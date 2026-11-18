// The runner seam through the built CLI: `--version --json`, `review deliver` and `events flush`
// print one typed JSON line carrying the CLI version and the sha256 of dist/cli.js.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { cli, execute, impl } from "../lib/adapter.ts";
import { claudeGame, deliver } from "../lib/claude-fixture.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { record } from "../lib/event-passes.ts";
import type { Json } from "../lib/json.ts";
import { at } from "../lib/time.ts";
import { KIT_ROOT } from "../lib/workspace.ts";

const SLOT = new Date(at(20) * 1000).toISOString();

function identity(): Json {
  const dist = readFileSync(join(KIT_ROOT, "dist", "cli.js"));
  const { version } = JSON.parse(readFileSync(join(KIT_ROOT, "package.json"), "utf8")) as Json;
  return { version, distSha256: createHash("sha256").update(dist).digest("hex") };
}

function line(stdout: string): Json {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.slice(0, -1)).not.toContain("\n");
  return JSON.parse(stdout) as Json;
}

suite("runner seam", () => {
  const workspace = workspaces();

  contract("--version --json names the version and the dist/cli.js digest", async () => {
    const ws = workspace();
    const plain = await execute(impl.bare(ws, ["--version"]));
    expect(plain.stdout).toBe(`${identity().version}\n`);
    const json = await execute(impl.bare(ws, ["--version", "--json"]));
    expect(json.code).toBe(0);
    expect(line(json.stdout)).toEqual({ schema: 1, ...identity() });
  });

  contract("review deliver delivers once and repeats the recorded result", async () => {
    const ws = workspace();
    claudeGame(ws);
    const first = await cli(ws, ["review", "deliver", "--slot", SLOT]);
    expect(first.code, first.stderr).toBe(0);
    expect(line(first.stdout)).toMatchObject({
      schema: 1,
      kind: "review-deliver",
      game: ws.game,
      slot: SLOT,
      status: "delivered",
      reason: null,
      cli: identity(),
    });
    await deliver(ws);
    const repeat = await cli(ws, ["review", "deliver", "--slot", SLOT]);
    expect(repeat.stdout).toBe(first.stdout);
    expect(ws.list("unblock", "claude-spool").filter((name) => name.endsWith(".json"))).toEqual([]);
    const usage = await cli(ws, ["review", "deliver", "--slot", "not-a-time"]);
    expect(usage).toMatchObject({ code: 2, stdout: "" });
  });

  contract("events flush reports delivered and held counts", async () => {
    const ws = workspace();
    claudeGame(ws);
    await record(ws, { kind: "attempt", key: "seam-attempt", message: "scheduled attempt" });
    const spooled = await cli(ws, ["events", "flush"]);
    expect(spooled.code, spooled.stderr).toBe(0);
    expect(line(spooled.stdout)).toMatchObject({
      schema: 1,
      kind: "events-flush",
      game: ws.game,
      status: "deferred",
      delivered: 0,
      held: 1,
      cli: identity(),
    });
    await deliver(ws);
    expect(line((await cli(ws, ["events", "flush"])).stdout)).toMatchObject({
      status: "delivered",
      reason: null,
      delivered: 1,
      held: 0,
    });
  });
});
