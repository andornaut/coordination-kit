// The runner seam through the built CLI: `--version --json` and `review deliver` print one typed
// JSON line carrying the CLI version and the sha256 of dist/cli.js.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { cli, execute, impl } from "../lib/adapter.ts";
import { claudeGame } from "../lib/claude-fixture.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
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
    const repeat = await cli(ws, ["review", "deliver", "--slot", SLOT]);
    expect(repeat.stdout).toBe(first.stdout);
    const app = await cli(ws, ["review", "deliver", "--app", ws.game, "--slot", SLOT]);
    expect(app.code, app.stderr).toBe(0);
    const { game, ...legacy } = line(first.stdout);
    expect(game).toBe(ws.game);
    expect(line(app.stdout)).toEqual({ ...legacy, appId: ws.game });
    expect(Object.keys(line(app.stdout))).toEqual([
      "schema",
      "kind",
      "appId",
      "slot",
      "status",
      "reason",
      "detail",
      "cli",
    ]);

    const unscoped = await execute(impl.bare(ws, ["review", "show", "--slot", SLOT]));
    const show = await cli(ws, ["review", "show", "--app", ws.game, "--slot", SLOT]);
    expect(unscoped.code, unscoped.stderr).toBe(0);
    expect(show.code, show.stderr).toBe(0);
    const { game: shownGame, ...brief } = line(unscoped.stdout);
    expect(shownGame).toBe(ws.game);
    expect(line(show.stdout)).toEqual({ ...brief, appId: ws.game });

    const usage = await cli(ws, ["review", "deliver", "--slot", "not-a-time"]);
    expect(usage).toMatchObject({ code: 2, stdout: "" });
  });

  contract("events flush is retired: the runner ingests its event log instead", async () => {
    const ws = workspace();
    claudeGame(ws);
    expect(await cli(ws, ["events", "flush"])).toMatchObject({ code: 2, stdout: "" });
  });
});
