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

import { LedgerStore } from "../accounting/store.ts";
import type { LedgerCommand, LedgerSource } from "../accounting/types.ts";
import { EXIT_OK, EXIT_USAGE, main } from "../cli.ts";
import { loadLayout } from "../layout.ts";
import { ProtocolStore } from "../protocol/core.ts";
import { activateProtocolFixture } from "../protocol/testFixtures.ts";
import { WorkStore } from "../protocol/work.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, CLAUDE_TECH, CODEX_TECH } from "../testFixtures.ts";
import {
  collectStatus,
  type StatusItem,
  type StatusOptions,
  type StatusReport,
} from "./collect.ts";
import { type GitRunner, systemGit } from "./git.ts";
import { DIGEST_HEADINGS } from "./markdown.ts";
import { sourceCounters } from "./sources.ts";

const GAME = "sample-game";
const KIT = "sample-kit";
const ROLE = `games/${GAME}/tech`;
const AT = "2026-10-01T00:00:00.000Z";
const BINDING = { harness: "claude" as const, nativeId: CLAUDE_TECH };
const SOURCE: LedgerSource = {
  native: null,
  origin: "owner-attested",
  reference: "fixture:approved-work",
  wordingHash: null,
};
const USER_SOURCE: LedgerSource = { ...SOURCE, reference: "user, fixture request" };
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

async function ledgerApply(
  ledger: LedgerStore,
  actor: string,
  source: LedgerSource,
  commandId: string,
  command: LedgerCommand,
): Promise<void> {
  await ledger.apply({
    actor,
    at: AT,
    command,
    commandId,
    expectedRevision: ledger.read().revision,
    schema: 1,
    source,
  });
}

function request(
  id: string,
  question: "pending" | null,
  source: LedgerSource = SOURCE,
): LedgerCommand {
  return {
    request: {
      assignment: null,
      dependencies: [],
      id,
      kind: "request",
      parentId: null,
      question:
        question === null
          ? null
          : { native: null, options: null, resolutionRef: null, status: question, text: "Which?" },
      reviewed: true,
      source,
      summary: `Fixture ${id}`,
      targets: [
        {
          consumers: [],
          criteria: [{ description: "Checked", id: "check", requiredEvidence: ["check"] }],
          description: "Exact source",
          id: "target",
        },
      ],
    },
    type: "register",
  };
}

async function publish(
  protocol: ProtocolStore,
  ledger: LedgerStore,
  id: string,
  requestId: string,
): Promise<void> {
  const store = new WorkStore({ protocol, readRequest: (key) => ledger.read(key) });
  await store.publish(
    {
      at: AT,
      binding: BINDING,
      epoch: protocol.read(ROLE).epoch,
      expectedRevision: protocol.read(ROLE).revision,
      id: `publish-${id}`,
      role: ROLE,
    },
    {
      definition: {
        artifacts: [await protocol.putArtifact(Buffer.from(`essential ${id}`))],
        clauseIds: [],
        criteria: [{ consumers: [], id: "check", phases: ["check"], targetId: "target" }],
        id,
        messageIds: [],
        plan: await protocol.putArtifact(Buffer.from(`plan ${id}`)),
        requestIds: [requestId],
        retention: null,
        source: null,
      },
      expectedWorkRevision: 0,
      ready: false,
      replaces: null,
    },
  );
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
  createRegistry(layout, {
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

  const stateRoot = activateProtocolFixture(layout);
  const protocol = new ProtocolStore({ directory: stateRoot, resolveBinding: () => true });
  await protocol.claim({
    at: AT,
    binding: BINDING,
    evidence: "fixture:owner",
    expectedEpoch: 0,
    role: ROLE,
  });
  const ledger = new LedgerStore({ directory: join(stateRoot, "accounting") });
  await ledgerApply(
    ledger,
    "game-coordinator",
    SOURCE,
    "register-6",
    request("request-sg6", "pending"),
  );
  await ledgerApply(
    ledger,
    "game-coordinator",
    SOURCE,
    "register-12",
    request("request-sg12", null),
  );
  await ledgerApply(
    ledger,
    `${GAME}/tech`,
    USER_SOURCE,
    "register-new",
    request("request-new", null, USER_SOURCE),
  );
  await ledgerApply(ledger, "game-coordinator", SOURCE, "block-12", {
    id: "request-sg12",
    nextBoundary: "next review",
    reason: "Waiting on the sidecar art",
    requiredOwner: `${GAME}/art`,
    state: "blocked",
    type: "progress",
  });
  await publish(protocol, ledger, "sg-0006", "request-sg6");
  await publish(protocol, ledger, "sg-0012", "request-sg12");
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
  return collectStatus(
    { counters: sourceCounters(), git: systemGit({}), io: { env: {} } },
    fixture.root,
    { ...ALL, ...options },
  );
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
    expect(report.coordinator.protocol).toEqual({ status: "available" });
    expect(report.coordinator.ledger).toEqual({ status: "available" });
  });

  it("derives each status by precedence", () => {
    const statuses = Object.fromEntries(report.items.map((entry) => [entry.id, entry.status]));
    expect(statuses).toEqual({
      "request-new": "requested",
      "sg-0001": "approved",
      "sg-0002": "proposed",
      "sg-0003": "declined",
      "sg-0004": "cancelled",
      "sg-0005": "superseded",
      "sg-0006": "in-progress",
      "sg-0007": "landed",
      "sg-0008": "done",
      "sg-0009": "deployed",
      "sg-0010": "landed",
      "sg-0011": "approved",
      "sg-0012": "in-progress",
      "sg-0013": "done",
      "sg-0014": "done",
      "sg-0015": "deployed",
      "sg-0016": "deployed",
      "sk-0001": "done",
      "sk-0002": "landed",
      "sk-0003": "deployed",
    });
    expect(item(report, "sg-0005").replacement).toBe("sg-0006");
    expect(item(report, "request-new")).toMatchObject({
      repository: GAME,
      title: "Fixture request-new",
      workFile: null,
    });
  });

  it("lands an item where its work file is set to done, else by ID or title citations", () => {
    expect(item(report, "sg-0001").delivery.landing).toBeNull();
    expect(item(report, "sg-0007").delivery).toEqual({
      deployed: null,
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

  it("dates deployment by the first COMPLETE event, last deploy or release tag", () => {
    expect(item(report, "sg-0009").delivery.deployed).toEqual({
      at: completedAt(fixture),
      matched: "landing",
      sha: fixture.sha.sg9,
      tag: null,
      via: "complete",
    });
    expect(item(report, "sg-0015").delivery.deployed).toMatchObject({
      at: expect.any(String),
      matched: "landing",
      sha: fixture.sha.sg15,
      via: "last-deploy",
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

  it("joins protocol publications, ledger requests, blockers and pending questions", () => {
    const sg6 = item(report, "sg-0006");
    expect(sg6.protocol).toEqual([
      {
        accepted: 0,
        authorization: "reviewed",
        beforeWork: "refused",
        criteriaSatisfied: false,
        guarded: true,
        historicallyClosed: false,
        joinedBy: ["id"],
        ready: false,
        receipts: 0,
        retention: null,
        revision: 1,
        role: ROLE,
        workers: [],
      },
    ]);
    expect(sg6.requests).toMatchObject([{ id: "request-sg6", question: "pending", state: "open" }]);
    expect(sg6).toMatchObject({ blocked: false, waitingOnUser: true });
    expect(item(report, "sg-0012")).toMatchObject({
      blocked: true,
      blocker: "Waiting on the sidecar art",
      owner: `${GAME}/art`,
      waitingOnUser: false,
    });
    expect(item(report, "sg-0012").protocol?.[0]?.beforeWork).toBe("admissible");
    expect(item(report, "sg-0001")).toMatchObject({
      blocked: false,
      blocker: null,
      owner: null,
      protocol: [],
      requests: [],
    });
    expect(item(report, "sg-0002").waitingOnUser).toBe(true);
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
      ["sg-0007", "sg-0009", "sg-0010", "sg-0015", "sg-0016", "sk-0002", "sk-0003"],
    );
    const since = item(report, "sg-0014").delivery.landing!.at;
    expect(run(fixture, { since, scope: GAME }).items.map((entry) => entry.id)).toEqual([
      "sg-0014",
    ]);
    expect(() => run(fixture, { scope: "nowhere" })).toThrow(/--scope/);
  });

  it("prints JSON by default and a digest per repository with --format markdown", async () => {
    const json = await cli(fixture);
    expect(json.code).toBe(EXIT_OK);
    expect(JSON.parse(json.out)).toMatchObject({ schema: 1 });
    const digest = await cli(fixture, "--format", "markdown");
    expect(digest.code).toBe(EXIT_OK);
    const section = digest.out.split(`## ${GAME}\n`)[1]!.split("\n## ")[0]!;
    expect(section.match(/^### .*$/gm)).toEqual(DIGEST_HEADINGS.map((heading) => `### ${heading}`));
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
      "- sg-0009:",
      "- sg-0013:",
      "- sg-0014:",
      "- sg-0015:",
      "- sg-0016:",
    ]);
    expect(under("In progress")).toEqual(["- sg-0007:", "- sg-0010:", "- sg-0012:"]);
    expect(under("New")).toEqual(["- request-new:"]);
    expect(under("Outstanding")).toEqual(["- sg-0001:", "- sg-0011:"]);
    expect(digest.out).not.toContain("(unverified)");
    const verifySince = item(report, "sg-0014").delivery.landing!.at;
    const strict = await cli(fixture, "--format", "markdown", "--verify-since", verifySince);
    expect(strict.out.match(/^- .*\(unverified\).*$/gm)).toEqual([
      expect.stringMatching(/^- sg-0014: Done after the cutoff \(unverified\) \(done; landed /),
    ]);
    expect((await cli(fixture, "--verify-since", "soon")).code).toBe(EXIT_USAGE);
    expect(under("Waiting on the user")).toEqual(["- sg-0002:", "- sg-0006:"]);
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

  it("reads each repository in a fixed number of git calls and the state once", () => {
    const measure = () => {
      const calls: { cwd: string; command: string }[] = [];
      const counters = sourceCounters();
      collectStatus({ counters, git: countingGit(calls), io: { env: {} } }, fixture.root, ALL);
      return { calls, counters };
    };
    const first = measure();
    const logs = first.calls.filter((call) => call.command === "log");
    expect(logs).toHaveLength(6);
    expect(first.calls.filter((call) => call.command === "rev-parse")).toHaveLength(4);
    expect(first.counters.ledgerReads).toBe(1);
    expect([...first.counters.roleReads.values()].every((count) => count === 1)).toBe(true);
    expect(first.counters.roleReads.has(ROLE)).toBe(true);

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
    expect(second.counters.ledgerReads).toBe(1);
    expect([...second.counters.roleReads.values()].every((count) => count === 1)).toBe(true);
    const bulk = run(fixture, { scope: GAME, states: ["landed"] }).items.filter((entry) =>
      entry.id.startsWith("sg-01"),
    );
    expect(bulk).toHaveLength(10);
  });
});
