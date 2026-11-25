import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { type GitRunner, systemGit } from "../core/git.ts";
import { EXIT_OK, EXIT_USAGE } from "../core/io.ts";
import { loadLayout } from "../core/layout.ts";
import {
  CLAUDE_COORDINATOR,
  CLAUDE_TECH,
  CODEX_TECH,
  stateRootFixture,
  TEST_CLOCK,
} from "../core/testFixtures.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { Store } from "../store/db.ts";
import { sendMessage } from "../store/messages.ts";
import { openQuestion, setHold } from "../store/questions.ts";
import { importRequest, type RequestImport } from "../store/requests.ts";
import { collectStatus, type StatusItem, type StatusReport } from "./collect.ts";

type StatusOptions = Parameters<typeof collectStatus>[2];

const GAME = "sample-game";
const KIT = "sample-kit";
const TECH_ROLE = `${GAME}/tech`;
const UNREAD = "00000000-0000-4000-8000-000000000970";
const AT = "2026-10-01T00:00:00.000Z";
function request(id: string, owner: string, fields: Partial<RequestImport> = {}): RequestImport {
  return {
    id,
    kind: "request",
    owner,
    question: null,
    reason: null,
    requiredOwner: null,
    source: { origin: "owner-attested", reference: "fixture:approved-work" },
    state: "open",
    summary: `Fixture ${id}`,
    updatedAt: AT,
    work: [],
    ...fields,
  };
}

const ALL: StatusOptions = {
  audit: false,
  scope: "all",
  since: null,
  states: [],
  verifySince: "2026-11-19T02:00:00Z",
};

let clock = Date.parse("2026-11-01T00:00:00Z");

function gitEnv(): NodeJS.ProcessEnv {
  const at = new Date(clock).toISOString();
  clock += 3_600_000;
  return {
    GIT_AUTHOR_DATE: at,
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_COMMITTER_DATE: at,
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: tmpdir(),
    PATH: process.env.PATH,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
}

/** Write (or delete, for null) each file, then commit everything; returns the new SHA. */
function commit(repo: string, message: string, files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      rmSync(join(repo, path));
    } else {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function work(
  id: string,
  title: string,
  status: string,
  extra: { approved?: string; design?: string; supersedes?: string } = {},
): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    `status: ${status}`,
    `approved: ${extra.approved ?? "fixture, 2026-11-01"}`,
    `design: ${extra.design ?? "tech"}`,
    ...(extra.supersedes === undefined ? [] : [`supersedes: ${extra.supersedes}`]),
    "---",
    "",
    "## Scope",
    "",
    "Fixture.",
    "",
  ].join("\n");
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
}

interface Fixture {
  readonly base: string;
  readonly root: string;
  readonly stateRoot: string;
  readonly game: string;
  readonly sha: Record<string, string>;
}

async function buildFixture(): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "status-fixture-"));
  const root = join(base, "game-coordinator");
  const game = join(base, GAME);
  const kit = join(base, KIT);
  const sha: Record<string, string> = {};

  initRepo(root);
  writeFileSync(
    join(root, "config.json"),
    `${JSON.stringify({
      games: { [GAME]: { name: "Sample", path: `../${GAME}`, roles: ["art", "gameplay", "tech"] } },
      kits: { [KIT]: { path: `../${KIT}` } },
      schema: 1,
      sharedRoles: ["game-coordinator", KIT],
      timezone: "America/Toronto",
      wakeMinutes: [],
    })}\n`,
  );
  writeFileSync(join(root, ".gitignore"), "var/\n");
  commit(root, "Start the coordinator", {});

  initRepo(game);
  commit(game, "Start the game", { ".gitignore": ".worktrees/\n", "README.md": "Game\n" });
  sha.approve = commit(game, "Approve sg-0001 to sg-0010", {
    "docs/work/pending-sidecars.md": work("pending-sidecars", "Load the sidecars", "approved"),
    "docs/work/sg-0001.md": work("sg-0001", "Approved and untouched", "approved"),
    "docs/work/sg-0002.md": work("sg-0002", "Proposed by the user", "proposed", {
      approved: "user, 2026-11-01, requested",
    }),
    "docs/work/sg-0003.md": work("sg-0003", "Declined change", "declined"),
    "docs/work/sg-0004.md": work("sg-0004", "Cancelled change", "cancelled"),
    "docs/work/sg-0005.md": work("sg-0005", "Original decision", "approved"),
    "docs/work/sg-0006.md": work("sg-0006", "Replacement decision", "approved", {
      supersedes: "sg-0005",
    }),
    "docs/work/sg-0007.md": work("sg-0007", "Landed only", "approved"),
    "docs/work/sg-0008.md": work("sg-0008", "Delivered and accepted", "approved", {
      approved: "user, 2026-11-01, fixture",
    }),
    "docs/work/sg-0009.md": work("sg-0009", "Deployed before acceptance", "approved"),
    "docs/work/sg-0010.md": work("sg-0010", "Polish the menu", "approved"),
    "docs/work/sg-0012.md": work("sg-0012", "Blocked on art", "approved", { design: "art" }),
    "docs/work/sg-0013.md": work("sg-0013", "Done before the cutoff", "approved"),
    "docs/work/sg-0014.md": work("sg-0014", "Done after the cutoff", "approved"),
    "docs/work/sg-0015.md": work("sg-0015", "Deployed by the last deploy", "approved"),
    "docs/work/sg-0016.md": work("sg-0016", "Listed by a COMPLETE event", "approved"),
    "package.json": "{}\n",
  });
  sha.sg8 = commit(game, "Build the delivered thing", {
    "docs/work/sg-0008.md": work("sg-0008", "Delivered and accepted", "done", {
      approved: "user, 2026-11-01, fixture",
    }),
    "src/b.ts": "b\n",
  });
  sha.sg9 = commit(game, "Wire sg-0009", { "src/c.ts": "c\n" });
  sha.sg15 = commit(game, "Wire sg-0015", { "src/f.ts": "f\n" });
  sha.sg7 = commit(game, "Add the sg-0007 feature", { "src/a.ts": "a\n" });
  sha.sg10 = commit(game, "Polish the menu", { "src/d.ts": "d\n" });
  sha.sg11 = commit(game, "Load enemy data from the sidecars map", {
    "docs/work/pending-sidecars.md": `${work("pending-sidecars", "Load the sidecars", "approved")}Notes.\n`,
    "src/e.ts": "e\n",
  });
  git(game, "mv", "docs/work/pending-sidecars.md", "docs/work/sg-0011.md");
  writeFileSync(
    join(game, "docs/work/sg-0011.md"),
    `${work("sg-0011", "Load the sidecars", "approved")}Notes.\n`,
  );
  sha.number = commit(game, "Number the sidecars work item as sg-0011", {});
  sha.sg13 = commit(game, "Mark sg-0013 done", {
    "docs/work/sg-0013.md": work("sg-0013", "Done before the cutoff", "done"),
  });
  sha.sg14 = commit(game, "Mark the late item done", {
    "docs/work/sg-0014.md": work("sg-0014", "Done after the cutoff", "done"),
  });
  git(game, "update-ref", "refs/remotes/origin/main", sha.sg7);
  git(game, "worktree", "add", "-q", "-b", "tech", ".worktrees/tech", "main");

  initRepo(kit);
  commit(kit, "Start the kit", { "README.md": "Kit\n" });
  commit(kit, "Approve sk-0001 to sk-0003", {
    "docs/work/sk-0001.md": work("sk-0001", "Add the parser", "approved"),
    "docs/work/sk-0002.md": work("sk-0002", "Add the logger", "approved"),
    "docs/work/sk-0003.md": work("sk-0003", "Add the printer", "approved"),
  });
  sha.sk1 = commit(kit, "Add the parser (sk-0001)", {
    "docs/work/sk-0001.md": work("sk-0001", "Add the parser", "done"),
    "src/p.ts": "p\n",
  });
  sha.sk3 = commit(kit, "Add the printer (sk-0003)", { "src/q.ts": "q\n" });
  git(kit, "tag", "v1.0.0");
  sha.sk2 = commit(kit, "Add the logger (sk-0002)", { "src/r.ts": "r\n" });
  git(kit, "tag", "draft");
  git(kit, "update-ref", "refs/remotes/origin/main", sha.sk2);

  const layout = loadLayout(root);
  createRegistry(TEST_CLOCK, layout, {
    harness: "claude",
    host: { nativeProjectId: "project-1", root: "." },
    operations: {},
    roles: {
      "game-coordinator": {
        conversations: { claude: CLAUDE_COORDINATOR },
        ownership: "active",
        worktree: ".",
      },
      [`${GAME}/art`]: {
        conversations: { codex: CODEX_TECH },
        ownership: "active",
        worktree: `../${GAME}`,
      },
      [`${GAME}/tech`]: {
        conversations: { claude: CLAUDE_TECH },
        ownership: "active",
        worktree: `../${GAME}/.worktrees/tech`,
      },
      [KIT]: { conversations: {}, ownership: "active", worktree: `../${KIT}` },
    },
    schema: 1,
    transfers: [],
  } as unknown as Omit<Registry, "revision" | "updatedAt">);

  const events = join(root, "var", "games", GAME, "bus", "events");
  mkdirSync(events, { recursive: true });
  const event = (kind: string, key: string, created: string, extra = "") =>
    writeFileSync(
      join(events, `${createHash("sha256").update(`${kind}:${key}`).digest("hex")}.json`),
      `{"created": ${created}, "id": "x", "key": "${key}", "kind": "${kind}", "message": "m", "sent": true${extra}}\n`,
    );
  const completed = Date.parse(git(game, "show", "-s", "--format=%cI", sha.sg9)) + 1_800_000;
  event("push", sha.sg10, `${completed + 1}000000`);
  event("complete", sha.sg9, `${completed}000000`);
  event("complete", sha.approve, `${completed + 600_000}000000`, ', "work": ["sg-0016", 7]');
  writeFileSync(join(base, "completed"), new Date(completed).toISOString());
  const deployedAt =
    Math.floor(Date.parse(git(game, "show", "-s", "--format=%cI", sha.sg15)) / 1000) + 60;
  writeFileSync(join(root, "var", "games", GAME, "bus", "last-deploy.sha"), `${sha.sg15}\n`);
  writeFileSync(join(root, "var", "games", GAME, "bus", "last-deploy"), `${deployedAt}\n`);
  writeFileSync(join(events, `${sha.sg9}.state`), "{}\n");

  const stateRoot = stateRootFixture(layout);
  const store = Store.open(TEST_CLOCK, join(stateRoot, "coordination.db"));
  const importer = { nativeId: null, role: "game-coordinator" };
  importRequest(
    store,
    importer,
    request("request-sg6", TECH_ROLE, { question: "pending", work: ["sg-0006"] }),
  );
  importRequest(
    store,
    importer,
    request("request-sg12", TECH_ROLE, {
      reason: "Waiting on the sidecar art",
      requiredOwner: `${GAME}/art`,
      state: "blocked",
      work: ["sg-0012"],
    }),
  );
  importRequest(
    store,
    importer,
    request("request-new", TECH_ROLE, {
      source: { origin: "owner-attested", reference: "user, fixture request" },
    }),
  );
  importRequest(store, importer, request("request-closed", TECH_ROLE));
  importRequest(
    store,
    importer,
    request("legacy-unmatched", "retired-role", { work: ["missing-0001"] }),
  );
  store.transaction(() =>
    store.append({
      actor: { nativeId: CLAUDE_TECH, role: TECH_ROLE },
      key: "request.closed:request-closed",
      kind: "request.closed",
      payload: { id: "request-closed", reason: "Carried by sg-0001", work: "sg-0001" },
    }),
  );
  openQuestion(
    store,
    { nativeId: CODEX_TECH, role: TECH_ROLE },
    {
      codex: { dependsOn: [{ id: "sg-0001", repository: GAME }], thread: CODEX_TECH },
      id: "exact-question",
      options: [{ label: "First", description: "First candidate." }, { label: "Second" }],
      title: "Choose a revision",
      work: "sg-0001",
    },
  );
  sendMessage(store, importer, {
    body: "Unread status fixture.",
    id: UNREAD,
    intent: "queue",
    to: TECH_ROLE,
  });
  setHold(
    store,
    { nativeId: CLAUDE_TECH, role: TECH_ROLE },
    {
      id: "exact-hold",
      reason: "Waiting for a check",
      scope: "role",
    },
  );
  // The read-only command must also read questions in a store predating answer projection.
  store.db.exec("DROP TABLE IF EXISTS question_answers; PRAGMA journal_mode = DELETE");
  store.close();
  return { base, game, root, sha, stateRoot };
}

/** Every path under `directory` with its type, mode, size, mtime and content digest. */
function fingerprint(directory: string): string[] {
  const rows: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
        rows.push(`d ${full} ${stat.mode} ${stat.mtimeMs}`);
        walk(full);
      } else if (stat.isSymbolicLink()) {
        rows.push(`l ${full} ${readlinkSync(full)}`);
      } else {
        const digest = createHash("sha256").update(readFileSync(full)).digest("hex");
        rows.push(`f ${full} ${stat.mode} ${stat.size} ${stat.mtimeMs} ${digest}`);
      }
    }
  };
  walk(directory);
  return rows;
}

function completedAt(fixture: Fixture): string {
  return readFileSync(join(fixture.base, "completed"), "utf8");
}

function countingGit(calls: { cwd: string; command: string }[]): GitRunner {
  const real = systemGit({});
  return (cwd, args) => {
    calls.push({ command: args[0] ?? "", cwd });
    return real(cwd, args);
  };
}

function run(fixture: Fixture, options: Partial<StatusOptions> = {}): StatusReport {
  return collectStatus({ git: systemGit({}), io: { env: {} } }, fixture.root, {
    ...ALL,
    ...options,
  });
}

function item(report: StatusReport, id: string): StatusItem {
  const found = report.items.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no item ${id}`);
  }
  return found;
}

async function cli(fixture: Fixture, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: "/nonexistent", env: {}, err: (text) => (err += text), out: (text) => (out += text) },
    ["--root", fixture.root, "status", ...args],
  );
  return { code, err, out };
}

describe("status", () => {
  let fixture: Fixture;
  let report: StatusReport;

  beforeAll(async () => {
    fixture = await buildFixture();
    report = run(fixture);
  });

  it("resolves each registered repository once through its worktree", () => {
    expect(
      report.repositories.map(({ kind, name, roles, status }) => ({ kind, name, roles, status })),
    ).toEqual([
      {
        kind: "coordinator",
        name: "game-coordinator",
        roles: ["game-coordinator"],
        status: "available",
      },
      { kind: "game", name: GAME, roles: [`${GAME}/art`, `${GAME}/tech`], status: "available" },
      { kind: "kit", name: KIT, roles: [KIT], status: "available" },
    ]);
    const gameRepo = report.repositories.find((repo) => repo.name === GAME)!;
    expect(gameRepo).toMatchObject({
      deployment: { channel: "bus", status: "available", unreadable: 0 },
      main: fixture.sha.sg14,
      originMain: fixture.sha.sg7,
    });
    expect(report.coordinator).toEqual({ root: fixture.root, store: { status: "available" } });
  });

  it("derives each status by precedence", () => {
    const statuses = Object.fromEntries(report.items.map((entry) => [entry.id, entry.status]));
    expect(statuses).toEqual({
      "request-new": "requested",
      "legacy-unmatched": "requested",
      "sg-0001": "approved",
      "sg-0002": "proposed",
      "sg-0003": "declined",
      "sg-0004": "cancelled",
      "sg-0005": "superseded",
      "sg-0006": "approved",
      "sg-0007": "approved",
      "sg-0008": "done",
      "sg-0009": "approved",
      "sg-0010": "approved",
      "sg-0011": "approved",
      "sg-0012": "in-progress",
      "sg-0013": "done",
      "sg-0014": "done",
      "sg-0015": "approved",
      "sg-0016": "deployed",
      "sk-0001": "done",
      "sk-0002": "approved",
      "sk-0003": "approved",
    });
    expect(item(report, "sg-0005").replacement).toBe("sg-0006");
    expect(item(report, "request-new")).toMatchObject({
      repository: GAME,
      title: "Fixture request-new",
      workFile: null,
    });
  });

  it("keeps ID and title citations as heuristic lineage", () => {
    expect(item(report, "sg-0001").delivery.landing).toBeNull();
    expect(item(report, "sg-0007").delivery).toEqual({
      deployed: null,
      heuristicDeployment: null,
      landing: { at: expect.any(String), rule: "id", sha: fixture.sha.sg7 },
      onOrigin: true,
    });
    expect(item(report, "sg-0008").delivery.landing).toMatchObject({
      rule: "done-flip",
      sha: fixture.sha.sg8,
    });
    // A docs-only commit setting done still lands the item; the ID citation there does not.
    expect(item(report, "sg-0013").delivery.landing).toMatchObject({
      rule: "done-flip",
      sha: fixture.sha.sg13,
    });
    expect(item(report, "sk-0001").delivery.landing).toMatchObject({
      rule: "done-flip",
      sha: fixture.sha.sk1,
    });
    expect(item(report, "sg-0010").delivery).toMatchObject({
      landing: { rule: "title", sha: fixture.sha.sg10 },
      onOrigin: false,
    });
    expect(item(report, "sg-0011").delivery.landing).toBeNull();
    expect(item(report, "sg-0001").workFile?.addedIn).toBe(fixture.sha.approve);
    expect(item(report, "sg-0011").workFile?.addedIn).toBe(fixture.sha.number);
  });

  it("dates exact deployments and separately exposes deployment of heuristic citations", () => {
    expect(item(report, "sg-0009").delivery.heuristicDeployment).toEqual({
      at: completedAt(fixture),
      matched: "landing",
      sha: fixture.sha.sg9,
      tag: null,
      via: "complete",
    });
    expect(item(report, "sg-0015").delivery.heuristicDeployment).toMatchObject({
      at: expect.any(String),
      matched: "landing",
      sha: fixture.sha.sg15,
      via: "last-deploy",
    });
    expect(item(report, "sg-0015")).toMatchObject({
      delivery: { deployed: null },
      deliverySource: { deployment: null, landing: null },
      deliveryVerified: null,
      status: "approved",
    });
    expect(item(report, "sg-0016")).toMatchObject({
      delivery: {
        deployed: { matched: "work-list", sha: fixture.sha.approve, via: "complete" },
        landing: null,
      },
      deliveryEvidence: "deployed",
      deliveryVerified: true,
    });
    expect(item(report, "sg-0007").delivery.deployed).toBeNull();
    expect(item(report, "sg-0010").delivery.deployed).toBeNull();
    expect(item(report, "sk-0001").delivery.deployed).toMatchObject({
      sha: fixture.sha.sk3,
      tag: "v1.0.0",
      via: "release",
    });
    expect(item(report, "sk-0002").delivery.deployed).toBeNull();
  });

  it("verifies done items by evidence and assumes those marked done before the cutoff", () => {
    expect(item(report, "sg-0008")).toMatchObject({
      deliveryEvidence: "deployed",
      deliveryVerified: true,
    });
    for (const id of ["sg-0013", "sg-0014"]) {
      expect(item(report, id)).toMatchObject({
        deliveryEvidence: "assumed",
        deliveryVerified: null,
        status: "done",
      });
    }
    const verifySince = item(report, "sg-0014").delivery.landing!.at;
    const strict = run(fixture, { verifySince });
    expect(item(strict, "sg-0013")).toMatchObject({ deliveryEvidence: "assumed" });
    expect(item(strict, "sg-0014")).toMatchObject({
      deliveryEvidence: null,
      deliveryVerified: false,
      status: "done",
    });
    expect(run(fixture, { states: ["unverified"], verifySince }).items.map((e) => e.id)).toEqual([
      "sg-0014",
    ]);
    expect(item(report, "sg-0001")).toMatchObject({
      deliveryEvidence: null,
      deliveryVerified: null,
    });
  });

  it("joins imported requests, blockers and pending questions", () => {
    const sg6 = item(report, "sg-0006");
    expect(sg6).not.toHaveProperty("protocol");
    expect(sg6.requests).toMatchObject([{ id: "request-sg6", question: "pending", state: "open" }]);
    expect(sg6).toMatchObject({ blocked: false, waitingOnUser: true });
    expect(item(report, "sg-0012")).toMatchObject({
      blocked: true,
      blocker: "Waiting on the sidecar art",
      owner: `${GAME}/art`,
      status: "in-progress",
      waitingOnUser: false,
    });
    expect(item(report, "sg-0001")).toMatchObject({
      blocked: false,
      blocker: null,
      owner: null,
      requests: [{ id: "request-closed", owner: TECH_ROLE, state: "closed" }],
    });
    expect(report.items.map((entry) => entry.id)).not.toContain("request-closed");
    expect(item(report, "request-new")).toMatchObject({
      owner: null,
      requests: [{ id: "request-new", owner: TECH_ROLE, state: "open", userSource: true }],
      status: "requested",
    });
    expect(item(report, "sg-0002").waitingOnUser).toBe(true);
    expect(item(report, "sg-0001").waitingOnUser).toBe(true);
    expect(report.unmatchedRequests).toContainEqual(
      expect.objectContaining({
        id: "legacy-unmatched",
        repository: null,
        work: ["missing-0001"],
      }),
    );
  });

  it("lists only user-originated items under --audit, each with its evidence", () => {
    const audit = run(fixture, { audit: true });
    expect(audit.items.map((entry) => entry.id)).toEqual(["request-new", "sg-0002", "sg-0008"]);
    expect(item(audit, "sg-0008")).toMatchObject({
      delivery: {
        deployed: { at: completedAt(fixture), matched: "landing", sha: fixture.sha.sg9 },
        landing: { sha: fixture.sha.sg8 },
        onOrigin: true,
      },
      workFile: {
        addedIn: fixture.sha.approve,
        commit: fixture.sha.sg8,
        path: "docs/work/sg-0008.md",
      },
    });
  });

  it("filters by scope, repeated state and since", () => {
    expect(run(fixture, { scope: KIT }).items.map((entry) => entry.id)).toEqual([
      "sk-0001",
      "sk-0002",
      "sk-0003",
    ]);
    expect(run(fixture, { scope: KIT }).repositories.map((repo) => repo.name)).toEqual([KIT]);
    expect(run(fixture, { scope: `${GAME}/art` }).items.map((entry) => entry.id)).toEqual([
      "sg-0012",
    ]);
    expect(run(fixture, { states: ["landed", "deployed"] }).items.map((entry) => entry.id)).toEqual(
      ["sg-0016"],
    );
    const since = item(report, "sg-0014").delivery.landing!.at;
    const recent = run(fixture, { since, scope: GAME });
    expect(recent.items.map((entry) => entry.id)).toContain("sg-0015");
    expect(recent.items.map((entry) => entry.id)).not.toContain("sg-0013");
    expect(recent.recentCompletions.map((entry) => entry.id)).toEqual(["sg-0014"]);
    expect(recent.recentActivity.map((entry) => entry.id)).not.toContain("sg-0015");
    const future = run(fixture, { scope: TECH_ROLE, since: "2100-01-01" });
    expect(future.pendingQuestions).toMatchObject([{ id: "exact-question", work: "sg-0001" }]);
    expect(future.unread).toMatchObject([
      { id: UNREAD, to: TECH_ROLE, wake: { outcome: "unknown" } },
    ]);
    expect(future.activeHolds).toMatchObject([{ id: "exact-hold", scope: "role" }]);
    expect(future.recentActivity).toEqual([]);
    expect(future.recentCompletions).toEqual([]);
    expect(run(fixture, { scope: KIT }).pendingQuestions).toEqual([]);
    expect(run(fixture, { scope: KIT }).unread).toEqual([]);
    expect(run(fixture, { scope: KIT }).activeHolds).toEqual([]);
    expect(() => run(fixture, { scope: "nowhere" })).toThrow(/--scope/);
  });

  it("prints JSON by default and a digest per repository with --format markdown", async () => {
    const json = await cli(fixture);
    expect(json.code).toBe(EXIT_OK);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 2 });
    const digest = await cli(fixture, "--format", "markdown");
    expect(digest.code).toBe(EXIT_OK);
    expect(digest.out).toContain(`Codex thread ${CODEX_TECH}`);
    expect(digest.out).toContain("Option 1. First (First candidate.)\n  - Option 2. Second");
    expect(digest.out).toContain("## Unread originals (1)");
    expect(digest.out).toContain(`- ${UNREAD} (${TECH_ROLE}) unknown`);
    const section = digest.out.split(`## ${GAME}\n`)[1]!.split("\n## ")[0]!;
    expect(section.match(/^### .*$/gm)).toEqual([
      "### Done",
      "### In progress",
      "### New",
      "### Outstanding",
      "### Waiting on the user",
    ]);
    const under = (heading: string) =>
      section
        .split(`### ${heading}\n`)[1]!
        .split("\n### ")[0]!
        .match(/^- (\S+?)[:\s]/gm);
    expect(under("Done")).toEqual([
      "- sg-0003:",
      "- sg-0004:",
      "- sg-0005:",
      "- sg-0008:",
      "- sg-0013:",
      "- sg-0014:",
      "- sg-0016:",
    ]);
    expect(under("In progress")).toEqual(["- sg-0012:"]);
    expect(under("New")).toEqual(["- request-new:"]);
    expect(under("Outstanding")).toEqual([
      "- sg-0007:",
      "- sg-0009:",
      "- sg-0010:",
      "- sg-0011:",
      "- sg-0015:",
    ]);
    expect(digest.out).not.toContain("(unverified)");
    const verifySince = item(report, "sg-0014").delivery.landing!.at;
    const strict = await cli(fixture, "--format", "markdown", "--verify-since", verifySince);
    expect(strict.out.match(/^- .*\(unverified\).*$/gm)).toEqual([
      expect.stringMatching(/^- sg-0014: Done after the cutoff \(unverified\) \(done; landed /),
    ]);
    expect((await cli(fixture, "--verify-since", "soon")).code).toBe(EXIT_USAGE);
    expect(under("Waiting on the user")).toEqual(["- sg-0001:", "- sg-0002:", "- sg-0006:"]);
    expect(digest.out).toContain("## Recorded pending questions");
    expect(digest.out).toContain("## Active holds");
    expect(digest.out).toContain("## Unmatched legacy requests");
    expect((await cli(fixture, "--state", "shipped")).code).toBe(EXIT_USAGE);
    expect((await cli(fixture, "--since", "yesterday")).code).toBe(EXIT_USAGE);
    expect((await cli(fixture, "--scope", "nowhere")).code).toBe(EXIT_USAGE);
  });

  it("writes nothing: trees, refs and coordinator state are unchanged", async () => {
    const before = [...fingerprint(fixture.base), ...fingerprint(fixture.stateRoot)];
    await cli(fixture, "--format", "markdown");
    await cli(fixture, "--audit");
    expect([...fingerprint(fixture.base), ...fingerprint(fixture.stateRoot)]).toEqual(before);
  });

  it("reads each repository in a fixed number of git calls", () => {
    const measure = () => {
      const calls: { cwd: string; command: string }[] = [];
      collectStatus({ git: countingGit(calls), io: { env: {} } }, fixture.root, ALL);
      return { calls };
    };
    const first = measure();
    const logs = first.calls.filter((call) => call.command === "log");
    expect(logs).toHaveLength(6);
    expect(first.calls.filter((call) => call.command === "rev-parse")).toHaveLength(4);

    const files: Record<string, string> = {};
    for (let index = 100; index < 400; index += 1) {
      files[`docs/work/sg-0${index}.md`] = work(`sg-0${index}`, `Bulk item ${index}`, "approved");
    }
    commit(fixture.game, "Approve the bulk items", files);
    for (let index = 100; index < 400; index += 10) {
      commit(fixture.game, `Land sg-0${index}`, { [`src/bulk-${index}.ts`]: `${index}\n` });
    }
    const second = measure();
    expect(second.calls.map((call) => call.command)).toEqual(
      first.calls.map((call) => call.command),
    );
    const bulk = run(fixture, { scope: GAME }).items.filter(
      (entry) => entry.id.startsWith("sg-01") && entry.delivery.landing?.rule === "id",
    );
    expect(bulk).toHaveLength(10);
  });

  // Runs last: it adds a commit to the fixture game and moves its last deployment.
  it("counts a last-deploy time only for the commit it names when filtering by since", () => {
    const bus = join(fixture.root, "var", "games", GAME, "bus");
    const later = commit(fixture.game, "A later change", { "src/later.ts": "1\n" });
    const deployedAt = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(join(bus, "last-deploy.sha"), `${later}\n`);
    writeFileSync(join(bus, "last-deploy"), `${deployedAt}\n`);
    const moved = run(fixture, { scope: GAME });
    expect(item(moved, "sg-0014").delivery.deployed).toMatchObject({
      sha: later,
      via: "last-deploy",
    });
    const since = new Date(deployedAt * 1000).toISOString();
    expect(
      run(fixture, { scope: GAME, since }).recentActivity.map((entry) => entry.id),
    ).not.toContain("sg-0014");
  });
});
