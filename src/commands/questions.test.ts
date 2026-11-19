import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, main } from "../cli.ts";
import { ART, COORDINATOR, storeFixture, TECH } from "../store/testStore.ts";

const TECH_ROLE = "archies-dog-walks/tech";
const ART_ROLE = "archies-dog-walks/art";
const OTHER = "00000000-0000-4000-8000-0000000000e9";

const WORK_FILE = `---
id: ag-0001
title: "Pick the palette"
status: approved
approved: user, 2026-11-18
design: art
---

## Scope

Pick the palette.

## Decisions

None yet.

## Outcome

Pending.
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: tmpdir(),
      PATH: process.env.PATH,
    },
  }).trim();
}

/** The game repository on `main` with one work file, and the tech role's worktree on `tech`. */
function gameRepository(base: string): string {
  const repo = join(base, "archies-dog-walks");
  mkdirSync(join(repo, "docs", "work"), { recursive: true });
  writeFileSync(join(repo, "docs", "work", "ag-0001.md"), WORK_FILE);
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Approve ag-0001");
  git(repo, "worktree", "add", "-q", "-b", "tech", ".worktrees/tech", "main");
  return repo;
}

function cli(root: string, cwd: string, env: NodeJS.ProcessEnv) {
  return async (...argv: string[]) => {
    let out = "";
    let err = "";
    const code = await main(
      { cwd, env, err: (text) => (err += text), out: (text) => (out += text) },
      ["--root", root, ...argv],
    );
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(out) as Record<string, unknown>;
    } catch {
      // Usage text is not JSON.
    }
    return { code, err, json, out };
  };
}

function setup() {
  const fixture = storeFixture();
  const env = (id: string) => ({ CLAUDE_CODE_SESSION_ID: id, PATH: process.env.PATH });
  return {
    ...fixture,
    art: cli(fixture.root, fixture.base, { CODEX_THREAD_ID: ART, PATH: process.env.PATH }),
    coordinator: cli(fixture.root, fixture.base, env(COORDINATOR)),
    reader: cli(fixture.root, fixture.base, { PATH: process.env.PATH }),
    stranger: cli(fixture.root, fixture.base, env(OTHER)),
    tech: cli(fixture.root, fixture.base, env(TECH)),
  };
}

describe("question commands", () => {
  it("fences open, answer and cancel to the owning role's binding", async () => {
    const { coordinator, reader, stranger, tech } = setup();
    expect((await reader("question", "open", "--title", "Ship it?")).err).toContain(
      "caller-unidentified",
    );
    expect((await stranger("question", "open", "--title", "Ship it?")).err).toContain(
      "caller-unbound",
    );
    const opened = await tech("question", "open", "--title", "Ship it?", "--work", "ag-0001");
    expect(opened.code, opened.err).toBe(EXIT_OK);
    expect(opened.json).toMatchObject({
      duplicate: false,
      question: { id: "q-archies-dog-walks-tech-1", role: TECH_ROLE, state: "pending" },
      schema: 1,
    });
    const id = "q-archies-dog-walks-tech-1";
    const refusals = await Promise.all([
      coordinator("question", "answer", "--id", id, "--work", "ag-0001", "--text", "Yes."),
      coordinator("question", "cancel", "--id", id, "--reason", "Not needed"),
    ]);
    for (const refused of refusals) {
      expect(refused.code).toBe(EXIT_INVALID);
      expect(refused.err).toBe("coordination-kit: not-owner\n");
    }
    const listed = await reader("question", "list", "--state", "pending");
    expect(listed.json).toMatchObject({ questions: [{ id, state: "pending" }] });
    const cancelled = await tech("question", "cancel", "--id", id, "--reason", "Not needed");
    expect(cancelled.json).toMatchObject({
      question: { state: "cancelled" },
      wake: { status: "none" },
    });
    expect((await reader("question", "list", "--state", "bogus")).code).toBe(2);
  });

  it("reads options from a file", async () => {
    const { base, tech } = setup();
    writeFileSync(
      join(base, "options.json"),
      JSON.stringify([{ description: "Recommended", label: "Ship" }, "Wait"]),
    );
    const opened = await tech(
      "question",
      "open",
      "--title",
      "Ship?",
      "--options-file",
      "options.json",
    );
    expect(opened.json).toMatchObject({
      question: { options: [{ description: "Recommended", label: "Ship" }, { label: "Wait" }] },
    });
    writeFileSync(join(base, "bad.json"), "[]");
    expect((await tech("question", "open", "--title", "x", "--options-file", "bad.json")).err).toBe(
      "coordination-kit: invalid-options\n",
    );
  });

  it("appends the decision line to the work file on main, unstaged, and lists the decision", async () => {
    const { base, reader, tech } = setup();
    const repo = gameRepository(base);
    await tech("question", "open", "--id", "q-palette", "--title", "Palette?");
    await tech("question", "open", "--id", "q-palette-2", "--title", "Palette again?");
    const answered = await tech(
      "question",
      "answer",
      "--id",
      "q-palette",
      "--work",
      "ag-0001",
      "--text",
      "Use the warm palette.",
    );
    expect(answered.code, answered.err).toBe(EXIT_OK);
    const path = join(repo, "docs", "work", "ag-0001.md");
    expect(answered.json).toMatchObject({
      decision: { by: "user", id: "ag-0001/D1", question: "q-palette", role: TECH_ROLE },
      question: { state: "answered" },
      workFile: { path, written: true },
    });
    const at = (answered.json!.decision as { at: string }).at.slice(0, 10);
    const second = await tech(
      "question",
      "answer",
      "--id",
      "q-palette-2",
      "--work",
      "ag-0001",
      "--text",
      "Use the cool palette.",
      "--supersedes",
      "D1",
    );
    expect(second.code, second.err).toBe(EXIT_OK);
    expect(readFileSync(path, "utf8")).toBe(
      WORK_FILE.replace(
        "None yet.",
        [
          `- D1 (user, ${at}; answers q-palette): Use the warm palette.`,
          `- D2 (user, ${at}; answers q-palette-2; supersedes D1): Use the cool palette.`,
        ].join("\n"),
      ),
    );
    expect(git(repo, "status", "--porcelain")).toBe("M docs/work/ag-0001.md");
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");
    expect(
      readFileSync(join(repo, ".worktrees", "tech", "docs", "work", "ag-0001.md"), "utf8"),
    ).toBe(WORK_FILE);
    const repeated = await tech(
      "question",
      "answer",
      "--id",
      "q-palette",
      "--work",
      "ag-0001",
      "--text",
      "Use the warm palette.",
    );
    expect(repeated.json).toMatchObject({ duplicate: true, workFile: { written: false } });
    const decisions = await reader("decision", "list", "--work", "ag-0001");
    expect(decisions.json).toMatchObject({
      decisions: [
        { id: "ag-0001/D1", supersedes: null },
        { id: "ag-0001/D2", supersedes: "ag-0001/D1" },
      ],
      schema: 1,
    });
    expect((await reader("decision", "list", "--role", "game-coordinator")).json).toEqual({
      decisions: [],
      schema: 1,
    });
  });

  it("refuses before any store write when the work file or the main checkout is unusable", async () => {
    const { base, reader, tech } = setup();
    const repo = gameRepository(base);
    await tech("question", "open", "--id", "q-a", "--title", "Palette?");
    const answer = (work: string) =>
      tech("question", "answer", "--id", "q-a", "--work", work, "--text", "Yes.");
    expect((await answer("ag-0002")).err).toBe("coordination-kit: work-file-missing\n");
    git(repo, "checkout", "-q", "-b", "other");
    expect((await answer("ag-0001")).err).toBe("coordination-kit: main-checkout-not-main\n");
    git(repo, "checkout", "-q", "main");
    expect((await reader("question", "list")).json).toMatchObject({
      questions: [{ id: "q-a", state: "pending" }],
    });
    expect((await reader("decision", "list")).json).toEqual({ decisions: [], schema: 1 });
  });
});

describe("hold commands", () => {
  it("fences set and release to the owner and lists holds", async () => {
    const { coordinator, reader, stranger, tech } = setup();
    expect(
      (await stranger("hold", "set", "--id", "h-1", "--scope", "role", "--reason", "Paused")).err,
    ).toBe("coordination-kit: caller-unbound\n");
    const set = await tech("hold", "set", "--id", "h-1", "--scope", "role", "--reason", "Paused");
    expect(set.json).toMatchObject({
      hold: { id: "h-1", role: TECH_ROLE, scope: "role", state: "active" },
    });
    expect((await coordinator("hold", "release", "--id", "h-1")).err).toBe(
      "coordination-kit: not-owner\n",
    );
    expect((await reader("hold", "list", "--state", "active")).json).toMatchObject({
      holds: [{ id: "h-1" }],
    });
    expect((await tech("hold", "release", "--id", "h-1")).json).toMatchObject({
      hold: { state: "released" },
    });
    expect((await reader("hold", "list", "--state", "active")).json).toEqual({
      holds: [],
      schema: 1,
    });
  });

  it("withholds a wake while the hold is active and wakes the owner on release", async () => {
    const { coordinator, tech } = setup();
    await tech("hold", "set", "--id", "h-1", "--scope", "role", "--reason", "Paused");
    const sent = await coordinator("msg", "send", "--to", TECH_ROLE, "--body", "Hello.");
    expect(sent.json).toMatchObject({ wake: { status: "guarded" } });
    const released = await tech("hold", "release", "--id", "h-1");
    expect(released.json).toMatchObject({ wake: { status: "accepted" } });
  });
});

describe("msg history bodies", () => {
  it("shows bodies only to the sender, the recipient and game-coordinator", async () => {
    const { art, coordinator, reader, tech } = setup();
    const sent = await tech("msg", "send", "--to", "game-coordinator", "--body", "Private body.");
    expect(sent.code, sent.err).toBe(EXIT_OK);
    const toArt = await coordinator("msg", "send", "--to", ART_ROLE, "--body", "Art body.");
    expect(toArt.code, toArt.err).toBe(EXIT_OK);
    const bodies = async (run: typeof tech, ...extra: string[]) => {
      const result = await run("msg", "history", ...extra);
      expect(result.code, result.err).toBe(EXIT_OK);
      return (result.json!.events as { kind: string; detail: { body?: string } }[])
        .filter((event) => event.kind === "msg.sent")
        .map((event) => event.detail.body ?? null);
    };
    expect(await bodies(reader)).toEqual([null, null]);
    expect(await bodies(tech)).toEqual([null, null]);
    expect(await bodies(tech, "--include-body")).toEqual(["Private body.", null]);
    expect(await bodies(art, "--include-body")).toEqual([null, "Art body."]);
    expect(await bodies(coordinator, "--include-body")).toEqual(["Private body.", "Art body."]);
    expect((await reader("msg", "history", "--include-body")).err).toBe(
      "coordination-kit: caller-unidentified\n",
    );
    expect((await reader("msg", "history", "--native-id", TECH)).code).toBe(2);
  });
});
