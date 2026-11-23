import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, main } from "../cli.ts";
import { reviewResultsDir } from "../review/deliver.ts";
import { type ClaudeFixture, claudeFixture, GAME, SLOT } from "../review/fixtures.ts";
import { REASON_TOKENS, reasonToken } from "../review/outcome.ts";

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
  extra: { entry?: string; signal?: AbortSignal } = {},
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
    expect(help.out).toContain("store retire --dry-run");
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
      ["events", "ingest"],
      ["events", "ingest", "--game", "no-such-game"],
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
    mkdirSync(reviewResultsDir(fixture.game), { recursive: true });
    writeFileSync(join(reviewResultsDir(fixture.game), `${SLOT}.json`), "{");
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
    expect(existsSync(join(reviewResultsDir(fixture.game), `${SLOT}.json`))).toBe(false);
    const listeners = process.listenerCount("SIGTERM");
    const pending = deliver(fixture);
    expect(process.listenerCount("SIGTERM")).toBe(listeners + 1);
    expect((await pending).code).toBe(EXIT_OK);
    expect(process.listenerCount("SIGTERM")).toBe(listeners);
  });
});

describe("reason tokens", () => {
  it("maps each existing deferral text and receipt status to a fixed token", () => {
    const cases: [string, string | null, string][] = [
      [
        "deferred",
        "review route is unavailable or invalid; its owner must verify identities and ownership",
        "route-unavailable",
      ],
      [
        "deferred",
        'var/route.json schema 1 is not supported: remove "monitor"',
        "route-unavailable",
      ],
      [
        "deferred",
        "workerParents requires parents in the active review route",
        "route-unavailable",
      ],
      ["deferred", "worker parents must be in the active review route", "route-unavailable"],
      [
        "deferred",
        "worker parents require conversations for the active harness",
        "route-unavailable",
      ],
      [
        "deferred",
        "worker parents require membership in the active review route",
        "route-unavailable",
      ],
      ["deferred", "recipient transport requires the Claude harness", "route-unavailable"],
      ["deferred", "review route endpoint harness missing or invalid", "route-unavailable"],
      ["blocked", "review route or state unavailable", "route-unavailable"],
      [
        "deferred",
        "provide CODEX_CONTROL_SOCKET and the installed unblock helper",
        "recipient-unavailable",
      ],
      [
        "deferred",
        "set CODEX_CONTROL_SOCKET to an available absolute Codex control socket path",
        "recipient-unavailable",
      ],
      ["deferred", "recipient has no conversation for the active harness", "recipient-unavailable"],
      [
        "deferred",
        "channel consumer has not claimed an earlier review brief",
        "recipient-unavailable",
      ],
      ["deferred", "claude agents listing unavailable", "recipient-unavailable"],
      ["deferred", "recipient session missing from claude agents listing", "recipient-unavailable"],
      ["deferred", "recipient session state unknown (reported: unknown)", "recipient-unavailable"],
      ["deferred", "recipient input availability unknown", "recipient-unavailable"],
      [
        "deferred",
        "queue inventory incomplete; inspect snapshot and retry reconciliation",
        "recipient-unavailable",
      ],
      ["blocked", "native metadata unavailable", "recipient-unavailable"],
      ["rejected", null, "recipient-unavailable"],
      ["deferred", "recipient session blocked", "recipient-busy"],
      [
        "deferred",
        "recipient state ambiguous or interrupted; no automatic resume",
        "recipient-busy",
      ],
      ["busy", null, "recipient-busy"],
      ["sending", null, "in-flight"],
      [
        "deferred",
        "recipient-bound user-decision clearance missing, invalid or pending",
        "question-pending",
      ],
      ["deferred", "recipient waiting on a question or approval", "question-pending"],
      [
        "deferred",
        "native question pending: question_turn_id=t question_item_id=i",
        "question-pending",
      ],
      ["deferred", "native question history incomplete or unknown", "question-pending"],
      ["deferred", "recipient resolution record missing or invalid", "question-pending"],
      ["deferred", "native answer proof requires the same completed head", "question-pending"],
      ["deferred", "recipient decision clearance changed", "question-pending"],
      ["ambiguous", "send outcome unavailable; do not resend", "receipt-ambiguous"],
      ["deferred", "previous send outcome unknown or refused; do not resend", "receipt-ambiguous"],
    ];
    for (const [status, reason, token] of cases) {
      expect(reasonToken(status, reason), `${status}: ${reason}`).toBe(token);
    }
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
