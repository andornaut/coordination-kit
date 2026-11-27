import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../core/cli/io.ts";
import { REASON_TOKENS } from "../core/cli/outcome.ts";
import { CLAUDE_TECH } from "../core/testFixtures.ts";
import { type ClaudeFixture, claudeFixture, GAME, RECIPIENT, SLOT } from "../review/fixtures.ts";

const VERSION = "0.0.0-test";
const ISO = new Date(SLOT * 1000).toISOString();

function useEnv(fixture: ClaudeFixture): void {
  for (const [key, value] of Object.entries(fixture.env)) {
    vi.stubEnv(key, value ?? "");
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(
  root: string,
  argv: readonly string[],
  extra: { entry?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<Run> {
  let out = "";
  let err = "";
  const code = await main(
    {
      cwd: "/nonexistent",
      env: {},
      err: (text) => (err += text),
      out: (text) => (out += text),
      ...extra,
    },
    ["--root", root, ...argv],
  );
  return { code, err, out };
}

/** The one stdout line, parsed; fails unless stdout is exactly one JSON line. */
function line(result: Run): Record<string, unknown> {
  expect(result.out.endsWith("\n")).toBe(true);
  expect(result.out.slice(0, -1)).not.toContain("\n");
  return JSON.parse(result.out) as Record<string, unknown>;
}

function deliver(fixture: ClaudeFixture, slot = ISO, ...extra: string[]): Promise<Run> {
  return run(fixture.layout.root, ["review", "deliver", "--game", GAME, "--slot", slot, ...extra]);
}

describe("--version", () => {
  it("keeps the plain line and prints the identity as one JSON line", async () => {
    const { root } = claudeFixture().layout;
    expect(await run(root, ["--version"])).toEqual({ code: EXIT_OK, err: "", out: `${VERSION}\n` });
    const json = await run(root, ["--version", "--json"]);
    expect(json.code).toBe(EXIT_OK);
    expect(json.out).toBe(`{"schema":1,"version":"${VERSION}","distSha256":"${"0".repeat(64)}"}\n`);
  });

  it("hashes the running entry file's bytes", async () => {
    const fixture = claudeFixture();
    const entry = join(fixture.base, "cli.js");
    writeFileSync(entry, "#!/usr/bin/env node\n// fixture bundle\n");
    const digest = createHash("sha256").update(readFileSync(entry)).digest("hex");
    expect(line(await run(fixture.layout.root, ["--version", "--json"], { entry }))).toEqual({
      distSha256: digest,
      schema: 1,
      version: VERSION,
    });
  });
});

describe("help", () => {
  it("lists the seam commands and no retired command", async () => {
    const help = await run(claudeFixture().layout.root, ["--help"]);
    expect(help.out).toContain("review deliver --game ID --slot ISO_TIMESTAMP\n");
    expect(help.out).toContain("events ingest --game ID\n");
    expect(help.out).toContain("store retire [--dry-run]");
    for (const retired of [
      "events flush",
      "message send",
      "protocol status",
      "ledger intake",
      "inbox snapshot",
      "--input-file",
      "--capture",
    ]) {
      expect(help.out).not.toContain(retired);
    }
    expect(help.out).toContain("--version --json");
  });
});

describe("review deliver", () => {
  it("exits 2 for usage errors and 1 for internal failures, with nothing on stdout", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    const root = fixture.layout.root;
    for (const argv of [
      ["review", "deliver", "--game", GAME],
      ["review", "deliver", "--slot", ISO],
      ["review", "deliver", "--game", GAME, "--slot", "1793556000"],
      ["review", "deliver", "--game", GAME, "--slot", "2026-11-18T15:30:30Z"],
      ["review", "deliver", "--game", GAME, "--slot", "2026-11-18T15:30:00"],
      ["review", "deliver", "--game", "no-such-game", "--slot", ISO],
      ["review", "deliver", "--game", GAME, "--slot", ISO, "--extra"],
      ["review", "deliver", "--app", GAME, "--game", GAME, "--slot", ISO],
      ["events", "ingest"],
      ["events", "ingest", "--game", "no-such-game"],
      ["events", "ingest", "--app", GAME, "--game", GAME],
      ["review", "show", "--app", GAME, "--game", GAME],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await run(root, argv);
      expect(result.code, argv.join(" ")).toBe(EXIT_USAGE);
      expect(result.out).toBe("");
      expect(result.err).toMatch(/^coordination-kit: /);
    }
    expect((await run(root, ["events", "flush", "--game", GAME])).code).toBe(EXIT_USAGE);
    const missing = await run(join(fixture.base, "absent"), [
      "review",
      "deliver",
      "--game",
      GAME,
      "--slot",
      ISO,
    ]);
    expect(missing).toMatchObject({ code: EXIT_INVALID, out: "" });
    const record = join(fixture.game.busDir, "unblock", "review-deliver", `${SLOT}.json`);
    mkdirSync(dirname(record), { recursive: true });
    writeFileSync(record, "{");
    const corrupt = await deliver(fixture);
    expect(corrupt).toMatchObject({ code: EXIT_INVALID, out: "" });
    expect(corrupt.err).toMatch(/^coordination-kit: review deliver failed: /);
  });

  it("stops on an aborted signal without a result or record, and removes its SIGTERM listener", async () => {
    const fixture = claudeFixture();
    useEnv(fixture);
    const aborted = await run(
      fixture.layout.root,
      ["review", "deliver", "--game", GAME, "--slot", ISO],
      { signal: AbortSignal.abort() },
    );
    expect(aborted).toMatchObject({ code: EXIT_INVALID, out: "" });
    expect(aborted.err).toContain("no delivery claimed");
    expect(existsSync(join(fixture.game.busDir, "unblock", "review-deliver", `${SLOT}.json`))).toBe(
      false,
    );
    const listeners = process.listenerCount("SIGTERM");
    const pending = deliver(fixture);
    expect(process.listenerCount("SIGTERM")).toBe(listeners + 1);
    expect((await pending).code).toBe(EXIT_OK);
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  });
});

describe("app runner permissions", () => {
  it("authenticates both selector forms in app mode before any runner state is written", async () => {
    const fixture = claudeFixture();
    const { apps, kits, schema, sharedRoles, timezone, wakeMinutes } = fixture.layout.config;
    writeFileSync(
      fixture.layout.configFile,
      JSON.stringify({
        appStateDir: "games",
        apps,
        kits,
        permissions: {
          "game-coordinator": {
            apps: { [GAME]: ["review:deliver", "events:ingest"] },
            workspace: [],
          },
        },
        schema,
        sharedRoles,
        timezone,
        wakeMinutes,
      }),
    );
    for (const argv of [
      ["review", "deliver", "--app", GAME, "--slot", ISO],
      ["events", "ingest", "--game", GAME],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await run(fixture.layout.root, argv)).toMatchObject({
        code: EXIT_INVALID,
        err: "coordination-kit: caller-unidentified\n",
        out: "",
      });
      // eslint-disable-next-line no-await-in-loop
      const denied = await run(fixture.layout.root, argv, {
        env: { CLAUDE_CODE_SESSION_ID: CLAUDE_TECH },
      });
      expect(denied).toMatchObject({ code: EXIT_INVALID, out: "" });
    }
    expect(existsSync(join(fixture.unblock, "review-deliver"))).toBe(false);
    expect(existsSync(join(fixture.game.busDir, "events.cursor"))).toBe(false);

    const result = await run(fixture.layout.root, ["events", "ingest", "--app", GAME], {
      env: { CLAUDE_CODE_SESSION_ID: RECIPIENT },
    });
    expect(result.code, result.err).toBe(EXIT_OK);
    expect(line(result)).toMatchObject({ appId: GAME, schema: 1 });
  });
});

describe("reason tokens", () => {
  it("keeps the fixed token set", () => {
    expect([...REASON_TOKENS].sort()).toEqual(
      [
        "already-delivered",
        "cli-error",
        "compaction-reserved",
        "held",
        "in-flight",
        "no-events",
        "nothing-due",
        "outbox-unreadable",
        "question-pending",
        "receipt-ambiguous",
        "recipient-busy",
        "recipient-unavailable",
        "route-unavailable",
      ].sort(),
    );
  });
});
