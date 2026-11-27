import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../core/cli/io.ts";
import { TEST_CONTEXT } from "../core/testFixtures.ts";
import { Store } from "../store/db.ts";
import { openQuestion, setHold } from "../store/decisions/questions.ts";
import { GAME, storeFixture, TECH } from "../store/testStore.ts";
import { recordEvidence, startWork } from "../store/work-records/work.ts";
import { workFind } from "./workFind.ts";

const TECH_ROLE = `${GAME}/tech`;
const ART_ROLE = `${GAME}/art`;

function git(cwd: string, ...args: string[]) {
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

function work(repo: string, id: string, title: string, owner?: string) {
  const directory = join(repo, "docs", "work");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${id}.md`),
    [
      "---",
      "approved: user, 2026-11-20",
      "design: tech",
      `id: ${id}`,
      ...(owner === undefined ? [] : [`owner: ${owner}`]),
      "status: approved",
      `title: ${title}`,
      "---",
      "",
      "## Scope",
      "",
      "Fixture.",
      "",
    ].join("\n"),
  );
}

function fixture() {
  const { base, layout, root } = storeFixture();
  const game = join(base, GAME);
  writeFileSync(join(root, ".gitignore"), "var/\n");
  work(root, "sc-0001", "Check preview delivery");
  work(game, "sg-0001", "Check preview delivery");
  work(game, "sg-0002", "Design preview controls", ART_ROLE);
  for (const repo of [root, game]) {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "Record approved work");
  }
  const actor = { nativeId: TECH, role: TECH_ROLE };
  const ref = { id: "sg-0001", repository: GAME };
  const sha = git(game, "rev-parse", "HEAD");
  const store = Store.forLayout(TEST_CONTEXT, layout);
  try {
    startWork(store, actor, { owner: TECH_ROLE, parent: null, ref });
    recordEvidence(store, actor, { ref, sha, stage: "implemented" });
    openQuestion(store, actor, {
      id: "preview-question",
      title: "Check the preview?",
      work: ref.id,
    });
    setHold(store, actor, { id: "preview-hold", reason: "Waiting for a check.", scope: "role" });
  } finally {
    store.close();
  }
  return { game, root, sha };
}

async function find(root: string, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await workFind(
    { cwd: root, env: {}, err: (line) => (err += line), out: (line) => (out += line) },
    root,
    args,
  );
  return { code, err, json: out === "" ? null : (JSON.parse(out) as unknown) };
}

describe("shared work discovery", () => {
  it("returns the exact committed work and scoped status evidence", async () => {
    const { game, root, sha } = fixture();
    work(game, "sg-0001", "Uncommitted title");
    const result = await find(root, "sg-0001", "--scope", `app:${GAME}`);
    expect(result).toMatchObject({
      code: EXIT_OK,
      json: {
        activeHolds: [{ id: "preview-hold" }],
        availability: { complete: true, store: { status: "available" } },
        match: "id",
        matches: [
          {
            id: "sg-0001",
            repository: GAME,
            status: "in-progress",
            store: { evidence: [{ sha, stage: "implemented" }] },
            title: "Check preview delivery",
            waitingOnUser: true,
            workFile: { approved: "user, 2026-11-20" },
            workOwner: TECH_ROLE,
          },
        ],
        pendingQuestions: [{ id: "preview-question" }],
        schema: 1,
        status: "match",
      },
    });
    expect(await find(root, "Uncommitted title")).toMatchObject({
      code: EXIT_OK,
      json: { matches: [], status: "no-match" },
    });
    expect(git(game, "status", "--short")).toBe("M docs/work/sg-0001.md");
  });

  it("preserves title ambiguity and filters by the resolved owner before work starts", async () => {
    const { root } = fixture();
    expect(await find(root, "Check preview delivery")).toMatchObject({
      code: EXIT_OK,
      json: {
        match: "title",
        matches: [{ repository: GAME }, { repository: "game-coordinator" }],
        status: "ambiguous",
      },
    });
    expect(await find(root, "preview controls", "--owner", ART_ROLE)).toMatchObject({
      code: EXIT_OK,
      json: {
        match: "tokens",
        matches: [{ id: "sg-0002", store: null, workOwner: ART_ROLE }],
        status: "match",
      },
    });
    expect(await find(root, "preview controls", "--owner", TECH_ROLE)).toMatchObject({
      code: EXIT_OK,
      json: { matches: [], status: "no-match" },
    });
  });

  it("distinguishes an unavailable selected checkout from a complete miss", async () => {
    const { game, root } = fixture();
    renameSync(game, `${game}-moved`);
    expect(await find(root, "missing work", "--scope", `app:${GAME}`)).toMatchObject({
      code: EXIT_INVALID,
      json: {
        availability: { complete: false, repositories: [{ name: GAME, status: "unavailable" }] },
        matches: [],
        status: "unavailable",
      },
    });
    expect(await find(root, "missing work", "--scope", "workspace")).toMatchObject({
      code: EXIT_OK,
      json: { availability: { complete: true }, matches: [], status: "no-match" },
    });
  });

  it("reports bad syntax without echoing the description or invalid owner", async () => {
    const { root } = fixture();
    const bad = await find(root, "private-text-marker", "--owner", "INVALID/ROLE/MARKER");
    expect(bad).toMatchObject({ code: EXIT_USAGE, json: null });
    expect(bad.err).not.toContain("private-text-marker");
    expect(bad.err).not.toContain("INVALID/ROLE/MARKER");
    expect(await find(root, "query", "--scope", "app:missing")).toMatchObject({
      code: EXIT_USAGE,
      json: null,
    });
  });
});
