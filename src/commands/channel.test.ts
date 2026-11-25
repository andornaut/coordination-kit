import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { readChannelStatus } from "../adapters/claude/channelStatus.ts";
import { wakeFilePath, writeWakeFile } from "../adapters/claude/wakeFile.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Io } from "../core/io.ts";
import { projectConfig, TEST_CLOCK, writeFixtureJson } from "../core/testFixtures.ts";
import { readRegistry, updateRegistry } from "../registry/store.ts";
import { diagnoseHarness } from "../review/diagnostics.ts";
import { claudeFixture, RECIPIENT } from "../review/fixtures.ts";
import { channel } from "./channel.ts";

function io(): Io & { errors: string[] } {
  const errors: string[] = [];
  return { cwd: "/", env: {}, err: (text) => void errors.push(text), errors, out: () => undefined };
}

describe("claude channel options", () => {
  it("serves the Claude recipient while the global default is Codex", async () => {
    const fixture = claudeFixture();
    updateRegistry(TEST_CLOCK, fixture.layout, 1, (draft) => {
      draft.harness = "codex";
      draft.roles["game-coordinator"]!.harness = "claude";
    });
    const input = new PassThrough();
    const lines: string[] = [];
    const done = channel(io(), fixture.layout.root, [], {
      input,
      write: (line) => void lines.push(line),
    });
    input.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ping" })}\n`);
    input.end();
    expect(await done).toBe(EXIT_OK);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { id: 1, jsonrpc: "2.0", result: {} },
    ]);
  });

  it("refuses a Codex recipient even while the global default is Claude", async () => {
    const fixture = claudeFixture();
    updateRegistry(TEST_CLOCK, fixture.layout, 1, (draft) => {
      draft.roles["game-coordinator"]!.harness = "codex";
      draft.roles["game-coordinator"]!.conversations.codex = RECIPIENT;
    });
    const errors = io();
    expect(
      await channel(errors, fixture.layout.root, [], {
        input: new PassThrough(),
        write: () => undefined,
      }),
    ).toBe(EXIT_INVALID);
    expect(errors.errors.join("")).toContain("claude harness for the recipient game-coordinator");
  });

  it("rejects a noncanonical conversation, a repeated game and the retired --state-dir", async () => {
    const fixture = claudeFixture();
    const streams = { input: new PassThrough(), write: () => undefined };
    for (const args of [
      ["--conversation", RECIPIENT.toUpperCase().replace("0", "A")],
      ["--game", "archies-dog-walks", "--game", "archies-dog-walks"],
      ["--state-dir", join(fixture.game.busDir, "unblock")],
      ["--poll-seconds", "0"],
      ["--unknown"],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await channel(io(), fixture.layout.root, args, streams), args.join(" ")).toBe(
        EXIT_USAGE,
      );
    }
  });

  it("requires one reports.recipient across the selected games without --conversation", async () => {
    const fixture = claudeFixture();
    const config = projectConfig("Chibi");
    (config.reports as Record<string, unknown>).recipient = "archies-dog-walks/tech";
    writeFixtureJson(join(fixture.base, "chibis-way-home/delivery-kit.json"), config);
    const errors = io();
    const streams = { input: new PassThrough(), write: () => undefined };
    expect(await channel(errors, fixture.layout.root, [], streams)).toBe(EXIT_INVALID);
    expect(errors.errors.join("")).toContain(
      "the selected games name different reports.recipient roles",
    );
    const input = new PassThrough();
    const done = channel(io(), fixture.layout.root, ["--game", "archies-dog-walks"], {
      input,
      write: () => undefined,
    });
    input.end();
    expect(await done).toBe(EXIT_OK);
  });

  it("emits one wake notification per seq increase and nothing else", async () => {
    const fixture = claudeFixture();
    const input = new PassThrough();
    const lines: string[] = [];
    const done = channel(
      io(),
      fixture.layout.root,
      ["--conversation", RECIPIENT, "--poll-seconds", "3600"],
      { input, write: (line) => void lines.push(line) },
    );
    const poll = async (count: number) => {
      input.write('{"method":"notifications/initialized"}\n');
      await vi.waitFor(() => expect(lines).toHaveLength(count));
      // A second drain proves nothing more is emitted for the same seq.
      input.write('{"method":"notifications/initialized"}\n');
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(lines).toHaveLength(count);
    };
    const wake = { count: 2, role: "game-coordinator" };
    try {
      await poll(0);
      writeWakeFile(fixture.layout, wake);
      await poll(1);
      writeWakeFile(fixture.layout, wake);
      writeWakeFile(fixture.layout, { ...wake, count: 4 });
      await poll(2);
      writeFileSync(wakeFilePath(fixture.layout, wake.role), '{"schema":1,"seq":');
      await poll(2);
    } finally {
      input.end();
      expect(await done).toBe(EXIT_OK);
    }
    expect(lines.map((line) => JSON.parse(line).params)).toEqual([
      {
        content: "2 new messages for game-coordinator: run coordination-kit inbox",
        meta: { kind: "wake", seq: "1" },
      },
      {
        content: "4 new messages for game-coordinator: run coordination-kit inbox",
        meta: { kind: "wake", seq: "3" },
      },
    ]);
  });

  it("keeps delivering the role's wakes after session start rebinds it after /clear", async () => {
    const fixture = claudeFixture();
    const input = new PassThrough();
    const lines: string[] = [];
    const done = channel(
      io(),
      fixture.layout.root,
      ["--conversation", RECIPIENT, "--poll-seconds", "3600"],
      { input, write: (line) => void lines.push(line) },
    );
    const drain = async (count: number) => {
      input.write('{"method":"notifications/initialized"}\n');
      await vi.waitFor(() => expect(lines).toHaveLength(count));
    };
    const wake = { count: 1, role: "game-coordinator" };
    try {
      await drain(0);
      writeWakeFile(fixture.layout, wake);
      await drain(1);
      // The /clear rebind rotates the role's Claude conversation while the channel keeps running.
      updateRegistry(TEST_CLOCK, fixture.layout, 1, (draft) => {
        draft.roles["game-coordinator"]!.conversations.claude =
          "00000000-0000-4000-8000-0000000000f1";
      });
      writeWakeFile(fixture.layout, { ...wake, count: 3 });
      await drain(2);
      input.write('{"method":"notifications/initialized"}\n');
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(lines).toHaveLength(2);
    } finally {
      input.end();
      expect(await done).toBe(EXIT_OK);
    }
    expect(lines.map((line) => JSON.parse(line).params)).toEqual([
      {
        content: "1 new messages for game-coordinator: run coordination-kit inbox",
        meta: { kind: "wake", seq: "1" },
      },
      {
        content: "3 new messages for game-coordinator: run coordination-kit inbox",
        meta: { kind: "wake", seq: "2" },
      },
    ]);
  });

  it("keys its status file by role, so the doctor still finds it after a /clear rebind", async () => {
    const fixture = claudeFixture();
    const input = new PassThrough();
    const done = channel(io(), fixture.layout.root, ["--conversation", RECIPIENT], {
      input,
      write: () => undefined,
    });
    input.end();
    expect(await done).toBe(EXIT_OK);
    expect(readChannelStatus(fixture.layout, "game-coordinator")).toMatchObject({
      conversation: RECIPIENT,
      pid: process.pid,
      role: "game-coordinator",
      schema: 2,
    });
    updateRegistry(TEST_CLOCK, fixture.layout, 1, (draft) => {
      draft.roles["game-coordinator"]!.conversations.claude =
        "00000000-0000-4000-8000-0000000000f1";
    });
    // The doctor reads each Claude role's status file, keyed by role, not by conversation. This
    // channel ended before the rebind, so its file still names the earlier binding.
    const { roles } = await diagnoseHarness(
      fixture.env,
      fixture.layout,
      readRegistry(fixture.layout),
      { roles: ["game-coordinator", "archies-dog-walks/tech"] },
    );
    expect(Object.fromEntries(roles.map((row) => [row.role, row.channel_server]))).toMatchObject({
      "archies-dog-walks/tech": { code: "status_file_missing", status: "unknown" },
      "game-coordinator": {
        code: "status_file_stale",
        conversation: RECIPIENT,
        pid: process.pid,
        status: "reported",
      },
    });
  });
});

describe("claude channel launched with a rotated conversation", () => {
  const OLD = RECIPIENT;
  const id = (n: number) => `00000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, "0")}`;
  const ROLE = "game-coordinator";
  /** The role's channel status file without a configured state root. */
  const statusFile = (layout: { readonly varDir: string }) =>
    join(layout.varDir, "channel", "roles", `${ROLE}.json`);

  /** `[id, predecessor, via]`, with the project directory name, else `-home-user-project`. */
  type Link = readonly [string, string, string] | readonly [string, string, string, string];

  /** A projects directory with OLD's transcript and each link's header in its project. */
  function transcripts(links: readonly Link[]): {
    readonly dir: string;
    add(link: Link): void;
  } {
    const dir = mkdtempSync(join(tmpdir(), "ck-channel-lineage-"));
    const project = join(dir, "-home-user-project");
    mkdirSync(project);
    mkdirSync(join(dir, "-home-user-other"));
    const user = JSON.stringify({ message: { content: "hi", role: "user" }, type: "user" });
    writeFileSync(join(project, `${OLD}.jsonl`), `${user}\n`);
    const add = ([session, from, via, name = "-home-user-project"]: Link) => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(
        join(dir, name, `${session}.jsonl`),
        `${JSON.stringify({
          sessionId: session,
          sessions: [{ id: from, type: "claude_code_session", via }],
          type: "derived-from",
        })}\n${user}\n`,
      );
    };
    links.forEach(add);
    return { add, dir };
  }

  async function launch(bound: string, projectsDir: string, now: () => number = () => 0) {
    const fixture = claudeFixture();
    updateRegistry(TEST_CLOCK, fixture.layout, 1, (draft) => {
      draft.roles[ROLE]!.conversations.claude = bound;
    });
    const input = new PassThrough();
    const lines: string[] = [];
    const done = channel(
      io(),
      fixture.layout.root,
      ["--conversation", OLD, "--poll-seconds", "3600"],
      { input, now, projectsDir, write: (line) => void lines.push(line) },
    );
    const poll = async () => {
      input.write('{"method":"notifications/initialized"}\n');
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    };
    const stop = async () => {
      input.end();
      expect(await done).toBe(EXIT_OK);
    };
    return { layout: fixture.layout, lines, poll, stop };
  }

  it.each([
    ["one /clear", [[id(0xe1), OLD, "clear"]], id(0xe1)],
    [
      "two /clear steps",
      [
        [id(0xe1), OLD, "clear"],
        [id(0xe2), id(0xe1), "clear"],
      ],
      id(0xe2),
    ],
    [
      "two /clear steps across project directories",
      [
        [id(0xe1), OLD, "clear", "-home-user-other"],
        [id(0xe2), id(0xe1), "clear", "-home-user-link"],
      ],
      id(0xe2),
    ],
  ] as const)("follows %s to the role's current binding", async (_, links, bound) => {
    const { dir } = transcripts(links);
    const served = await launch(bound, dir);
    try {
      await served.poll();
      expect(readChannelStatus(served.layout, ROLE)).toMatchObject({
        conversation: bound,
        role: ROLE,
      });
      writeWakeFile(served.layout, { count: 2, role: ROLE });
      await vi.waitFor(async () => {
        await served.poll();
        expect(served.lines).toHaveLength(1);
      });
    } finally {
      await served.stop();
    }
  });

  it.each([
    [
      "two cleared descendants",
      [
        [id(0xe1), OLD, "clear"],
        [id(0xe3), OLD, "clear"],
      ],
    ],
    [
      "two cleared descendants in different project directories",
      [
        [id(0xe1), OLD, "clear", "-home-user-other"],
        [id(0xe3), OLD, "clear", "-home-user-link"],
      ],
    ],
    ["a fork", [[id(0xe1), OLD, "fork"]]],
  ] as const)("stays unresolved for %s", async (_, links) => {
    const { dir } = transcripts(links);
    const served = await launch(id(0xe1), dir);
    try {
      writeWakeFile(served.layout, { count: 1, role: ROLE });
      await served.poll();
      await served.poll();
      expect(served.lines).toEqual([]);
      expect(existsSync(statusFile(served.layout))).toBe(false);
    } finally {
      await served.stop();
    }
  });

  it("rewrites its status file within the interval after a rebind", async () => {
    const { dir } = transcripts([[id(0xe1), OLD, "clear"]]);
    let clock = 1_000_000;
    const served = await launch(id(0xe1), dir, () => clock);
    try {
      await served.poll();
      const first = readChannelStatus(served.layout, ROLE);
      expect(first).toMatchObject({ conversation: id(0xe1) });
      updateRegistry(TEST_CLOCK, served.layout, 2, (draft) => {
        draft.roles[ROLE]!.conversations.claude = id(0xe2);
      });
      clock += 60_000 - 1;
      await served.poll();
      expect(readChannelStatus(served.layout, ROLE)).toMatchObject({ conversation: id(0xe1) });
      clock += 1;
      await served.poll();
      expect(readChannelStatus(served.layout, ROLE)).toEqual({
        ...first,
        conversation: id(0xe2),
      });
    } finally {
      await served.stop();
    }
  });

  it("scans the lineage at most once per interval while unresolved", async () => {
    const lineage = transcripts([]);
    let clock = 1_000_000;
    const served = await launch(id(0xe1), lineage.dir, () => clock);
    try {
      // The successor appears after the scan at start; the next scan waits for the interval.
      lineage.add([id(0xe1), OLD, "clear"]);
      clock += 60_000 - 1;
      await served.poll();
      expect(existsSync(statusFile(served.layout))).toBe(false);
      clock += 1;
      await served.poll();
      expect(readChannelStatus(served.layout, ROLE)).toMatchObject({ conversation: id(0xe1) });
    } finally {
      await served.stop();
    }
  });
});
