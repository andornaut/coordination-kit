import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../core/io.ts";
import { updateRegistry } from "../registry/index.ts";
import { dependentQuestions } from "../store/codexQuestions.ts";
import { Store } from "../store/db.ts";
import { ART, COORDINATOR, GAME, storeFixture, TECH } from "../store/testStore.ts";

const TECH_ROLE = "archies-dog-walks/tech";
const ART_ROLE = "archies-dog-walks/art";
const OTHER = "00000000-0000-4000-8000-0000000000e9";
const ROTATED = "00000000-0000-4000-8000-0000000000f1";

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

  it("takes options as repeated --option labels, not an input file", async () => {
    const { tech } = setup();
    const opened = await tech(
      "question",
      "open",
      "--title",
      "Ship?",
      "--option",
      "Ship",
      "--option",
      "Wait",
    );
    expect(opened.json).toMatchObject({
      question: { options: [{ label: "Ship" }, { label: "Wait" }] },
    });
    expect((await tech("question", "open", "--title", "x", "--options-file", "o.json")).code).toBe(
      2,
    );
  });

  it("persists a Codex prompt before presentation and shows unresolved evidence on resume", async () => {
    const { art, coordinator, reader } = setup();
    const title = "Choose the palette.\nWhich option should ship?";
    const opts = [
      '{ "label": "Warm", "description": "High saturation" }',
      '{ "label": "Cool", "description": "Low saturation" }',
    ];
    const opened = await art(
      "question",
      "open",
      "--id",
      "q-codex",
      "--title",
      title,
      "--option-json",
      opts[0]!,
      "--option-json",
      opts[1]!,
      "--depends-on",
      `${GAME}:ag-0001`,
    );
    expect(opened.json).toMatchObject({
      question: {
        codex: { dependsOn: [{ id: "ag-0001", repository: GAME }], native: null, thread: ART },
        options: [
          { description: "High saturation", label: "Warm" },
          { description: "Low saturation", label: "Cool" },
        ],
        title,
      },
    });
    expect((await coordinator("question", "reconcile", "--id", "q-codex")).err).toContain(
      "not-owner",
    );
    expect((await art("question", "reconcile", "--id", "q-codex")).json).toMatchObject({
      form: "unsupported",
      observation: { reason: "native-question-unlinked", status: "unknown" },
      question: { state: "pending" },
    });
    await coordinator("msg", "send", "--to", ART_ROLE, "--body", "Independent work.");
    expect((await art("session", "start")).json).toMatchObject({
      questionRecovery: { pending: [{ id: "q-codex", title }], unread: 1 },
    });
    expect((await art("question", "reask", "--id", "q-codex")).err).toContain(
      "native-question-unlinked",
    );
    expect((await reader("question", "list", "--state", "pending")).json).toMatchObject({
      questions: [{ id: "q-codex", state: "pending" }],
    });
  });

  it("lets the same role answer, cancel and close its Codex questions after a move to Claude", async () => {
    const { art, base, coordinator, layout, root } = setup();
    const open = (id: string) =>
      art("question", "open", "--id", id, "--title", `${id}?`, "--depends-on", `${GAME}:ag-0001`);
    const opened = await Promise.all(["q-answer", "q-cancel", "q-legacy"].map(open));
    expect(opened.map(({ code }) => code)).toEqual([EXIT_OK, EXIT_OK, EXIT_OK]);
    updateRegistry(layout, 1, (draft) => {
      draft.roles[ART_ROLE] = {
        ...draft.roles[ART_ROLE]!,
        conversations: { claude: ROTATED, codex: ART },
        harness: "claude",
      };
    });
    const moved = cli(root, base, { CLAUDE_CODE_SESSION_ID: ROTATED, PATH: process.env.PATH });
    const verbs: readonly (readonly string[])[] = [
      ["answer", "--id", "q-answer", "--work", "ag-0001", "--text", "Yes."],
      ["cancel", "--id", "q-cancel", "--reason", "Not needed."],
      ["close-legacy", "--id", "q-legacy", "--reason", "Closed.", "--approval", "user-1"],
    ];
    const refused = await Promise.all(verbs.map((verb) => coordinator("question", ...verb)));
    expect(refused.map(({ err }) => err)).toEqual(verbs.map(() => "coordination-kit: not-owner\n"));
    expect(
      (await moved("question", "close-legacy", "--id", "q-legacy", "--reason", "x")).code,
    ).toBe(EXIT_USAGE);
    const results = await Promise.all(verbs.map((verb) => moved("question", ...verb)));
    expect(results.map(({ code, err }) => [code, err])).toEqual(verbs.map(() => [EXIT_OK, ""]));
    expect(results.map(({ json }) => (json!.question as { state: string }).state)).toEqual([
      "answered",
      "cancelled",
      "cancelled",
    ]);
    expect(results[2]!.json).toMatchObject({ approval: "user-1", duplicate: false });
  });

  it("records --depends-on on Claude and keeps Claude questions out of the legacy close", async () => {
    const { layout, tech } = setup();
    const opened = await tech(
      "question",
      "open",
      "--id",
      "q-depends",
      "--title",
      "Depends?",
      "--depends-on",
      `${GAME}:ag-0001`,
    );
    expect(opened.code, opened.err).toBe(EXIT_OK);
    expect(opened.json).toMatchObject({
      question: { codex: { dependsOn: [{ id: "ag-0001", repository: GAME }], thread: TECH } },
    });
    await tech("question", "open", "--id", "q-plain", "--title", "Plain?");
    const refused = await Promise.all(
      ["q-depends", "q-plain"].map((id) =>
        tech("question", "close-legacy", "--id", id, "--reason", "x", "--approval", "r"),
      ),
    );
    expect(refused.map(({ err }) => err)).toEqual([
      "coordination-kit: legacy-question-required\n",
      "coordination-kit: legacy-question-required\n",
    ]);
    const store = Store.forLayout(layout);
    expect(dependentQuestions(store, { id: "ag-0001", repository: GAME })).toEqual(["q-depends"]);
    store.close();
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

  it("persists an exact answer without a role worktree, then projects in receipt order", async () => {
    const { base, coordinator, reader, tech } = setup();
    await tech("question", "open", "--id", "q-a", "--title", "Palette?", "--work", "ag-0001");
    await tech("question", "open", "--id", "q-b", "--title", "Font?", "--work", "ag-0001");
    const answer = (id: string, text: string) =>
      tech("question", "answer", "--id", id, "--work", "ag-0001", "--text", text);
    expect((await answer("q-a", "See /home/fixture/notes.")).err).toContain("text-not-public");
    expect(
      (await coordinator("msg", "send", "--to", TECH_ROLE, "--body", "Queued work.")).json,
    ).toMatchObject({ wake: { status: "guarded" } });
    const recorded = await answer("q-a", "Use the warm palette.");
    expect(recorded.code, recorded.err).toBe(EXIT_OK);
    expect(recorded.json).toMatchObject({
      decision: null,
      question: {
        answer: {
          projection: { reason: "worktree-unavailable", status: "failed" },
          text: "Use the warm palette.",
          work: "ag-0001",
        },
        state: "answered",
      },
      wake: { status: "guarded" },
      workFile: { path: null, written: false },
    });
    expect((await reader("question", "list", "--state", "pending")).json).toMatchObject({
      questions: [{ id: "q-b" }],
    });
    expect((await reader("question", "list", "--state", "answered")).json).toMatchObject({
      questions: [{ answer: { text: "Use the warm palette." }, id: "q-a" }],
    });
    expect((await answer("q-a", "Change the answer.")).err).toContain("already-closed");
    expect((await coordinator("question", "project", "--id", "q-a")).err).toContain("not-owner");

    const repo = gameRepository(base);
    const path = join(repo, "docs", "work", "ag-0001.md");
    writeFileSync(
      path,
      WORK_FILE.replace("None yet.", "- D1 (user, 2026-11-18): Existing choice."),
    );
    const later = await answer("q-b", "Keep the current font.");
    expect(later.json).toMatchObject({
      decision: null,
      question: { state: "answered" },
      workFile: { reason: "decision-predecessor-pending", status: "failed" },
    });
    expect((await coordinator("store", "rebuild")).code).toBe(EXIT_OK);
    const repaired = await tech("question", "project", "--id", "q-a");
    expect(repaired.json).toMatchObject({
      decision: { id: "ag-0001/D2", question: "q-a" },
      duplicate: true,
      workFile: { path, status: "applied", written: true },
    });
    expect((await answer("q-b", "Keep the current font.")).json).toMatchObject({
      decision: { id: "ag-0001/D3", question: "q-b" },
      duplicate: true,
      workFile: { status: "applied", written: true },
    });
    expect(readFileSync(path, "utf8")).toMatch(
      /- D1 .*Existing choice.\n- D2 .*Use the warm palette.\n- D3 .*Keep the current font./,
    );
  });

  it("restores a missing writeback and refuses to overwrite a different line with the same number", async () => {
    const { base, tech } = setup();
    const repo = gameRepository(base);
    const path = join(repo, "docs", "work", "ag-0001.md");
    await tech("question", "open", "--id", "q-a", "--title", "Palette?", "--work", "ag-0001");
    const recorded = await tech(
      "question",
      "answer",
      "--id",
      "q-a",
      "--work",
      "ag-0001",
      "--text",
      "Yes.",
    );
    expect(recorded.json).toMatchObject({ workFile: { status: "applied" } });
    const written = readFileSync(path, "utf8");
    writeFileSync(path, WORK_FILE);
    const project = () => tech("question", "project", "--id", "q-a");
    expect((await project()).json).toMatchObject({
      workFile: { status: "applied", written: true },
    });
    expect(readFileSync(path, "utf8")).toBe(written);

    const changed = written.replace("Yes.", "Different decision.");
    writeFileSync(path, changed);
    expect((await project()).json).toMatchObject({
      decision: { id: "ag-0001/D1", text: "Yes." },
      workFile: { reason: "decision-line-conflict", status: "failed", written: false },
    });
    expect(readFileSync(path, "utf8")).toBe(changed);
  });

  it("reports a missing work file or an unavailable main checkout without losing the answer", async () => {
    const { base, tech } = setup();
    const repo = gameRepository(base);
    await tech("question", "open", "--id", "q-a", "--title", "Palette?");
    const result = await tech(
      "question",
      "answer",
      "--id",
      "q-a",
      "--work",
      "ag-0002",
      "--text",
      "Yes.",
    );
    expect(result.json).toMatchObject({
      workFile: { reason: "work-file-missing", status: "failed" },
    });
    git(repo, "checkout", "-q", "-b", "other");
    expect((await tech("question", "project", "--id", "q-a")).json).toMatchObject({
      question: { state: "answered" },
      workFile: { reason: "main-checkout-not-main", status: "failed" },
    });
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

  it("records explicit coordinator policy holds and releases only the exact policy ID", async () => {
    const { coordinator, reader, tech } = setup();
    const args = [
      "hold",
      "policy-set",
      "--id",
      "policy-current",
      "--scope",
      `role:${TECH_ROLE}`,
      "--reason",
      "User paused Tech.",
      "--approval",
      "request-1",
    ];
    const release = ["hold", "policy-release", "--id", "policy-current", "--approval", "request-2"];
    expect((await tech(...args)).err).toContain("not-coordinator");
    expect((await coordinator(...args, "--worker", "unverified")).err).toContain("not-coordinator");
    expect(
      (await coordinator(...args.slice(0, 5), "role:unknown", ...args.slice(6))).err,
    ).toContain("policy-role-unregistered");
    expect((await coordinator(...args)).json).toMatchObject({
      duplicate: false,
      hold: {
        policy: {
          approval: "request-1",
          issuer: "game-coordinator",
          target: {
            kind: "role",
            role: TECH_ROLE,
          },
        },
        role: TECH_ROLE,
        source: "user-policy",
      },
    });
    expect((await coordinator(...args)).json).toMatchObject({ duplicate: true });
    expect(
      (await reader("hold", "list", "--role", TECH_ROLE, "--state", "active")).json,
    ).toMatchObject({ holds: [{ id: "policy-current" }] });
    expect((await tech("session", "start")).json).toMatchObject({ counts: { holds: 1 } });
    expect(
      (await coordinator("msg", "send", "--to", TECH_ROLE, "--body", "Independent work.")).json,
    ).toMatchObject({ wake: { status: "guarded" } });
    expect((await tech("hold", "release", "--id", "policy-current")).err).toContain("missing");
    expect((await tech(...release)).err).toContain("not-coordinator");

    await tech("hold", "set", "--id", "independent", "--scope", "role", "--reason", "Other hold.");
    await tech("question", "open", "--id", "q-independent", "--title", "Keep waiting?");
    expect((await coordinator(...release)).json).toMatchObject({
      duplicate: false,
      hold: { policy: { releaseApproval: "request-2" }, state: "released" },
      wakes: [{ role: TECH_ROLE, status: "guarded" }],
    });
    expect((await coordinator(...release)).json).toMatchObject({ duplicate: true });
    expect((await coordinator(...release.slice(0, -1), "request-3")).err).toContain("id-conflict");
    expect((await reader("hold", "list", "--state", "active")).json).toMatchObject({
      holds: [{ id: "independent" }],
    });
    expect((await reader("question", "list", "--state", "pending")).json).toMatchObject({
      questions: [{ id: "q-independent" }],
    });
  });

  it("validates registered policy scopes and distinguishes game wakes from exact work", async () => {
    const { coordinator, reader } = setup();
    const set = (id: string, scope: string) =>
      coordinator(
        "hold",
        "policy-set",
        "--id",
        id,
        "--scope",
        scope,
        "--reason",
        "User paused.",
        "--approval",
        "request-1",
      );
    expect((await set("policy-invalid", "game:missing")).err).toContain("policy-game-unregistered");
    expect((await set("policy-invalid", "work:missing:ag-0001")).err).toContain(
      "policy-repository-unregistered",
    );
    expect((await set("policy-work", `work:${GAME}:ag-0001`)).json).toMatchObject({
      hold: { policy: { target: { id: "ag-0001", kind: "work", repository: GAME } } },
    });
    expect(
      (await coordinator("msg", "send", "--to", TECH_ROLE, "--body", "Role inbox.")).json,
    ).toMatchObject({ wake: { status: "accepted" } });
    expect((await set("policy-game", `game:${GAME}`)).json).toMatchObject({
      hold: { policy: { target: { game: GAME, kind: "game" } } },
    });
    expect((await reader("hold", "list", "--role", ART_ROLE)).json).toMatchObject({
      holds: [{ id: "policy-game" }],
    });
    expect(
      (await coordinator("hold", "policy-release", "--id", "policy-work", "--approval", "r2")).json,
    ).toMatchObject({ wakes: [] });
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
