import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../../core/cli/io.ts";
import { clockAt, stateRootFixture, TEST_CLOCK } from "../../core/testFixtures.ts";
import { Store } from "../db.ts";
import { COORDINATOR, GAME, storeFixture, TECH } from "../testStore.ts";
import { readRequests } from "../work-records/requests.ts";
import { storeRetire } from "./retire.ts";

const TECH_ROLE = `${GAME}/tech`;
const AT = "2026-11-18T06:00:00.000Z";

function ledgerRequest(id: string, state: string, fields: Record<string, unknown> = {}) {
  return {
    assignment: null,
    createdBy: "game-coordinator",
    id,
    kind: "request",
    question: null,
    reason: null,
    requiredOwner: null,
    source: {
      native: null,
      origin: "owner-attested",
      reference: "fixture:ledger",
      wordingHash: null,
    },
    state,
    summary: `Fixture ${id}`,
    targets: [],
    updatedAt: AT,
    ...fields,
  };
}

/** A frozen ledger whose checkpoint covers both journal events, and the other retired paths. */
function legacyState(stateRoot: string, root: string, checkpoint: { stale?: boolean } = {}): void {
  const accounting = join(stateRoot, "accounting");
  mkdirSync(join(accounting, "events"), { recursive: true });
  mkdirSync(join(accounting, "intake"), { recursive: true });
  const requests = [
    ledgerRequest("request-open", "open", {
      assignment: { ownerRole: TECH_ROLE },
      targets: [{ id: "ag-0003" }, { id: "target" }],
    }),
    ledgerRequest("request-started", "started", {
      question: { status: "pending" },
      reason: "Waiting on art",
      requiredOwner: `${GAME}/art`,
    }),
    ledgerRequest("request-done", "completed"),
    ledgerRequest("request-unowned", "blocked", { createdBy: "retired-role" }),
  ];
  const state = { hash: "h2", requests, revision: 2 };
  const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex");
  writeFileSync(join(accounting, "checkpoint.json"), JSON.stringify({ digest, schema: 1, state }));
  writeFileSync(join(accounting, "events", "000000000001.json"), '{"revision":1,"hash":"h1"}');
  writeFileSync(
    join(accounting, "events", "000000000002.json"),
    JSON.stringify({ hash: checkpoint.stale === true ? "h-later" : "h2", revision: 2 }),
  );
  writeFileSync(join(accounting, "intake", `${"a".repeat(64)}.json`), "{}");
  writeFileSync(join(accounting, "intake", `${"b".repeat(64)}.json`), "{}");
  for (const [path, text] of [
    ["roles/game-coordinator/journal.json", "{}"],
    ["transport/messages/record.json", "{}"],
    ["locks/record.lock", ""],
    ["migration/plan.json", "{}"],
    ["migration-plan.json", "{}"],
  ] as const) {
    mkdirSync(join(stateRoot, path, ".."), { recursive: true });
    writeFileSync(join(stateRoot, path), text);
  }
  writeFileSync(join(root, "var", "work-protocol-fence.json"), '{"schema":1}');
}

function setup(options: { stale?: boolean } = {}) {
  const fixture = storeFixture();
  const stateRoot = stateRootFixture(fixture.layout);
  legacyState(stateRoot, fixture.root, options);
  const cli = async (env: NodeJS.ProcessEnv, ...argv: string[]) => {
    let out = "";
    let err = "";
    const code = await main(
      { cwd: fixture.base, env, err: (text) => (err += text), out: (text) => (out += text) },
      ["--root", fixture.root, ...argv],
    );
    return {
      code,
      err,
      json: out === "" ? undefined : (JSON.parse(out) as Record<string, unknown>),
    };
  };
  return { ...fixture, cli, stateRoot };
}

const COORDINATOR_ENV = { CLAUDE_CODE_SESSION_ID: COORDINATOR };
const TECH_ENV = { CLAUDE_CODE_SESSION_ID: TECH };

function tree(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

describe("store retire", () => {
  it("prints the counts on a dry run and writes nothing", async () => {
    const { cli, stateRoot } = setup();
    const before = tree(stateRoot);
    const dry = await cli({}, "store", "retire", "--dry-run");
    expect(dry.code, dry.err).toBe(EXIT_OK);
    expect(dry.json).toMatchObject({
      applied: false,
      archive: { bytes: null, sha256: null },
      dryRun: true,
      intakeOffers: { dropped: 2 },
      kind: "store-retire",
      requests: {
        alreadyImported: 0,
        byState: { blocked: 1, open: 1, started: 1 },
        closed: 1,
        imported: 3,
        ledger: 4,
        unowned: ["request-unowned"],
      },
      schema: 1,
      stateRoot,
    });
    expect(dry.json!.paths).toEqual([
      { bytes: 2, files: 1, path: "roles", present: true },
      expect.objectContaining({ files: 5, path: "accounting", present: true }),
      { bytes: 2, files: 1, path: "transport", present: true },
      { bytes: 0, files: 1, path: "locks", present: true },
      { bytes: 2, files: 1, path: "migration", present: true },
      { bytes: 2, files: 1, path: "migration-plan.json", present: true },
      { bytes: 12, files: 1, path: "var/work-protocol-fence.json", present: true },
    ]);
    expect(tree(stateRoot)).toEqual(before);
    expect((await cli({}, "store", "retire")).code).toBe(EXIT_USAGE);
    expect((await cli({}, "store", "retire", "--dry-run", "--apply")).code).toBe(EXIT_USAGE);
  });

  it("archives the retired paths with a manifest, imports open requests and keeps originals", async () => {
    const { cli, root, stateRoot } = setup();
    const refused = await cli(TECH_ENV, "store", "retire", "--apply");
    expect(refused).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: not-coordinator\n",
    });
    const originals = tree(stateRoot);
    const applied = await cli(COORDINATOR_ENV, "store", "retire", "--apply");
    expect(applied.code, applied.err).toBe(EXIT_OK);
    const archive = applied.json!.archive as Record<string, string | number>;
    expect(applied.json).toMatchObject({ applied: true, dryRun: false, duplicate: false });
    const bytes = readFileSync(String(archive.path));
    expect(archive.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(archive.bytes).toBe(bytes.length);
    const members = execFileSync("tar", ["-tzf", String(archive.path)], { encoding: "utf8" });
    for (const member of [
      "roles/game-coordinator/journal.json",
      "accounting/checkpoint.json",
      "transport/messages/record.json",
      "locks/record.lock",
      "migration/plan.json",
      "migration-plan.json",
      "var/work-protocol-fence.json",
    ]) {
      expect(members.split("\n")).toContain(member);
    }
    const manifest = JSON.parse(readFileSync(String(archive.manifest), "utf8"));
    expect(manifest).toMatchObject({
      archive: { bytes: bytes.length, sha256: archive.sha256 },
      kind: "phase4-archive",
      readWith: { package: "@andornaut/coordination-kit", version: "2.1.2" },
      schema: 1,
      stateRoot,
    });
    expect(manifest.paths).toHaveLength(7);
    expect(manifest.paths[0]).toEqual({ bytes: 2, files: 1, path: "roles" });
    // Every original stays in place; only the archive and its manifest are new.
    const after = tree(stateRoot).filter((path) => !path.startsWith(join(stateRoot, "archive")));
    expect(after.filter((path) => !path.includes("coordination.db"))).toEqual(originals);
    expect(existsSync(join(root, "var", "work-protocol-fence.json"))).toBe(true);
    const store = Store.open(TEST_CLOCK, join(stateRoot, "coordination.db"));
    try {
      const requests = readRequests(store.db);
      expect(requests.map((request) => [request.id, request.owner, request.state])).toEqual([
        ["request-open", TECH_ROLE, "open"],
        ["request-started", "game-coordinator", "started"],
        ["request-unowned", "retired-role", "blocked"],
      ]);
      expect(requests[0]).toMatchObject({ closed: null, work: ["ag-0003"] });
      expect(requests[1]).toMatchObject({
        question: "pending",
        reason: "Waiting on art",
        requiredOwner: `${GAME}/art`,
        source: { origin: "owner-attested", reference: "fixture:ledger" },
      });
      const retired = store.eventByKey("store.retired:phase4");
      expect(retired?.actor.role).toBe("game-coordinator");
      expect(retired?.payload).toMatchObject({ archive: { sha256: archive.sha256 } });
    } finally {
      store.close();
    }
  });

  it("makes a repeated apply a no-op that reports the recorded result", async () => {
    const { cli, stateRoot } = setup();
    const first = await cli(COORDINATOR_ENV, "store", "retire", "--apply");
    const files = tree(stateRoot);
    const again = await cli(COORDINATOR_ENV, "store", "retire", "--apply");
    expect(again.code, again.err).toBe(EXIT_OK);
    expect(again.json).toMatchObject({ applied: true, duplicate: true });
    expect(again.json!.archive).toEqual(first.json!.archive);
    expect(tree(stateRoot)).toEqual(files);
    const dry = await cli({}, "store", "retire", "--dry-run");
    expect(dry.json).toMatchObject({ applied: true, dryRun: true, duplicate: true });
  });

  it("names the archive and stamps its manifest with the clock it is given", async () => {
    const { layout, stateRoot } = setup();
    const clock = clockAt("2026-01-02T03:04:05.000Z");
    const applied = await storeRetire({ clock, env: COORDINATOR_ENV, layout }, {}, { apply: true });
    expect(applied.archive.path).toBe(join(stateRoot, "archive", "phase4-2026-01-02.tar.gz"));
    const manifest = JSON.parse(readFileSync(applied.archive.manifest, "utf8"));
    expect(manifest).toMatchObject({
      archive: { name: "phase4-2026-01-02.tar.gz" },
      createdAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("refuses a checkpoint that does not cover the journal", async () => {
    const { cli } = setup({ stale: true });
    expect(await cli({}, "store", "retire", "--dry-run")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: ledger-checkpoint-stale\n",
    });
  });
});

describe("request close", () => {
  it("closes only the owner's imported request, once", async () => {
    const { cli } = setup();
    await cli(COORDINATOR_ENV, "store", "retire", "--apply");
    const close = (env: NodeJS.ProcessEnv, ...extra: string[]) =>
      cli(env, "request", "close", "--id", "request-open", ...extra);
    expect(await close(COORDINATOR_ENV, "--reason", "Not mine")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: not-owner\n",
    });
    const closed = await close(
      TECH_ENV,
      "--reason",
      "Carried by the work item",
      "--work",
      "ag-0003",
    );
    expect(closed.code, closed.err).toBe(EXIT_OK);
    expect(closed.json).toMatchObject({
      duplicate: false,
      request: {
        closed: { reason: "Carried by the work item", work: "ag-0003" },
        id: "request-open",
      },
      schema: 1,
    });
    expect(
      (await close(TECH_ENV, "--reason", "Carried by the work item", "--work", "ag-0003")).json,
    ).toMatchObject({ duplicate: true });
    expect(await close(TECH_ENV, "--reason", "Another reason")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: already-closed\n",
    });
    expect(
      await cli(TECH_ENV, "request", "close", "--id", "request-missing", "--reason", "Gone"),
    ).toMatchObject({ code: EXIT_INVALID, err: "coordination-kit: missing\n" });
    expect((await cli(TECH_ENV, "request", "close", "--id", "request-open")).code).toBe(EXIT_USAGE);
    expect(
      await cli({}, "request", "close", "--id", "request-open", "--reason", "x"),
    ).toMatchObject({ code: EXIT_INVALID, err: "coordination-kit: caller-unidentified\n" });
  });
});
