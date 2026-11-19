import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { execute, impl } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import type { Workspace } from "../lib/workspace.ts";

const COORDINATOR = "00000000-0000-4000-8000-0000000000b1";
const SHA = "0123456789abcdef0123456789abcdef01234567";
/** The runner's log in the agreed contract format: eight lines, one malformed, then a torn tail. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "events.jsonl");

/** `events` commands get the game's configuration and `--game`; the others run bare. */
async function run(ws: Workspace, words: string[], env: Record<string, string> = {}) {
  const command = words[0] === "events" ? impl.command(ws, words) : impl.bare(ws, words);
  command.env = { ...command.env, ...env };
  const result = await execute(command);
  expect(result.code, `${words.join(" ")}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

suite("events ingest", () => {
  const workspace = workspaces();

  contract("ingests a contract-format events.jsonl into the store with COMPLETE", async () => {
    const ws = workspace();
    ws.writeRegistry({
      harness: "claude",
      revision: 1,
      roles: { "game-coordinator": { conversations: { claude: COORDINATOR } } },
      schema: 1,
    });
    const log = readFileSync(FIXTURE, "utf8");
    ws.write("events.jsonl", log);
    const result = await run(ws, ["events", "ingest"]);
    expect(result).toMatchObject({
      completed: 1,
      delivered: 7,
      game: ws.game,
      held: 1,
      ingested: 8,
      kind: "events-ingest",
      quarantined: 1,
      reason: null,
      schema: 1,
      status: "delivered",
    });
    const complete = log.slice(0, log.lastIndexOf("\n") + 1);
    const lines = complete.trimEnd().split("\n");
    const cursor = JSON.parse(ws.read("events.cursor")) as Record<string, unknown>;
    expect(Object.keys(cursor)).toEqual([
      "schema",
      "file",
      "offset",
      "lines",
      "lastId",
      "firstId",
      "inode",
      "dev",
      "at",
    ]);
    expect(cursor).toMatchObject({
      file: "events.jsonl",
      firstId: (JSON.parse(lines[0]!) as { id: string }).id,
      lastId: (JSON.parse(lines[7]!) as { id: string }).id,
      lines: 8,
      offset: Buffer.byteLength(complete, "utf8"),
      schema: 1,
    });
    expect(ws.read("events.quarantine.jsonl")).toBe(`${lines[6]}\n`);

    const inbox = await run(ws, ["inbox", "--include-body"], {
      CLAUDE_CODE_SESSION_ID: COORDINATOR,
    });
    const messages = inbox.messages as { body: string; from: string; links: unknown[] }[];
    expect(messages.every((message) => message.from === "delivery-kit")).toBe(true);
    // Five runner events and the COMPLETE become messages; gate_passed and ci_pending are quiet
    // and stay events only.
    expect(messages).toHaveLength(6);
    expect(
      messages.some((m) => m.body.includes("ci_pending") || m.body.includes("gate_passed")),
    ).toBe(false);
    expect(messages[2]!.body).toBe(
      `Fixture bus: pushed ok ${SHA.slice(0, 12)}: imported at 6.1 start`,
    );
    const last = messages.at(-1)!;
    expect(last.body).toBe(
      `Fixture bus: COMPLETE ${SHA}: gate ok, push ok, ci ok, deploy deploy_disabled (skipped); work: ck-0017`,
    );
    expect(last.links).toEqual([
      { kind: "commit", ref: SHA },
      { kind: "work", ref: "ck-0017" },
    ]);

    const again = await run(ws, ["events", "ingest"]);
    expect(again).toMatchObject({
      completed: 0,
      delivered: 0,
      held: 1,
      ingested: 0,
      reason: "in-flight",
      status: "deferred",
    });
  });
});
