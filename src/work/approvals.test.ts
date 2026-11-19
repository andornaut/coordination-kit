import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { EXIT_INVALID, EXIT_OK } from "../io.ts";
import { loadLayout } from "../layout.ts";
import { Store, storePath } from "../store/db.ts";
import { StoreError } from "../store/types.ts";
import { importApprovalLedger } from "./approvals.ts";
import { workShow, workStart } from "./live.ts";
import { GAME, IDS, KIT, live, liveFixture, liveIo, ROLES, workFile } from "./testLive.ts";

const IMPLEMENTED = "1111111111111111111111111111111111111111";
const MAIN = "2222222222222222222222222222222222222222";
const TECH_SHA = "3333333";

/** An approval ledger in the documented schemaVersion 1 format. */
function ledger(): Record<string, unknown> {
  return {
    entries: [
      {
        acceptanceCriteria: ["Published with a release receipt"],
        approval: { recipient: KIT, wording: "Fixture approval" },
        behavior: "Release the parser",
        deployedSha: null,
        id: "sk-0001",
        implementationSha: IMPLEMENTED,
        independentHolds: ["hold-a", "hold-d"],
        interactionProof: ["release:v1.0.0", `receipt ${"x".repeat(600)}`],
        mainSha: MAIN,
        owner: { harness: "claude", role: KIT },
        stage: "published",
        unresolved: [
          {
            gap: "Consumer adoption",
            nextAction: "after the next release",
            requiredOwner: ROLES.coordinator,
          },
        ],
      },
      {
        behavior: "Tech item.",
        id: "sg-approval-1",
        implementationSha: TECH_SHA,
        owner: ROLES.tech,
        stage: "implemented",
        unresolved: ["Interaction proof missing"],
      },
      {
        behavior: "Behaviour with no work file",
        id: "sg-approval-2",
        independentHolds: [{ id: "hold-b", owner: ROLES.art, reason: "Art pause" }],
        mainSha: "not-a-sha",
        owner: ROLES.art,
        stage: "approved",
      },
      { behavior: "Unknown owner", id: "x-approval", owner: "ghost/role" },
      "not an entry",
    ],
    independentHolds: {
      "hold-a": {
        behavior: "Phase boundary",
        owner: { harness: "claude", role: ROLES.coordinator },
        state: "preserved",
      },
      "hold-c": { reason: "Owner not recorded" },
      "hold-d": { behavior: "Released earlier", owner: ROLES.coordinator, state: "released" },
    },
    roles: { [KIT]: { checkpoint: "fixture" } },
    schemaVersion: 1,
  };
}

function fixture() {
  const made = liveFixture({
    game: { "sg-0001": workFile("sg-0001", "Tech item", "approved") },
    kit: { "sk-0001": workFile("sk-0001", "Add the parser", "approved") },
  });
  const file = join(made.base, "approval-ledger.json");
  writeFileSync(file, JSON.stringify(ledger()));
  return { ...made, file };
}

describe("approval-ledger import", () => {
  it("maps entries to work items and writes nothing on a dry run", () => {
    const made = fixture();
    const report = importApprovalLedger(
      { ...live(made), coordinatorRoot: made.root },
      {},
      { dryRun: true, file: made.file },
    );
    expect(existsSync(storePath(loadLayout(made.root)))).toBe(false);
    expect(report).toMatchObject({
      dryRun: true,
      entries: 5,
      events: {
        evidence: { insert: 7, unchanged: 0 },
        holds: { insert: 4, unchanged: 0 },
        retained: { insert: 2, unchanged: 0 },
      },
      holds: { closed: 1, ownerUnknown: 1, total: 4, uncovered: 2 },
      outcomes: {
        ambiguous: 0,
        invalid: 1,
        "mapped-id": 1,
        "mapped-title": 1,
        "no-work-file": 1,
        "owner-unregistered": 1,
        "repository-unavailable": 0,
      },
      skipped: { invalidSha: 0, unmappedEvidence: 1, unmappedRetained: 0 },
      stubs: [{ entries: ["sg-approval-2"], owner: ROLES.art, repository: GAME }],
    });
    expect(Object.values(report.outcomes).reduce((sum, count) => sum + count, 0)).toBe(
      report.entries,
    );
    expect(report.mapped).toEqual([
      { entry: "sk-0001", outcome: "mapped-id", work: { id: "sk-0001", repository: KIT } },
      {
        entry: "sg-approval-1",
        outcome: "mapped-title",
        work: { id: "sg-0001", repository: GAME },
      },
    ]);
  });

  it("imports evidence, retained items and holds once, as game-coordinator only", () => {
    const made = fixture();
    const context = (nativeId: string) => ({ ...live(made, nativeId), coordinatorRoot: made.root });
    expect(() =>
      importApprovalLedger(context(IDS.kit), {}, { dryRun: false, file: made.file }),
    ).toThrow(new StoreError("not-coordinator"));
    const report = importApprovalLedger(
      context(IDS.coordinator),
      {},
      {
        dryRun: false,
        file: made.file,
      },
    );
    expect(report.events.evidence).toEqual({ insert: 7, unchanged: 0 });
    const record = workShow(live(made), { id: "sk-0001", worktree: made.kit });
    expect(record.record?.evidence.map((item) => `${item.stage} ${item.ref}`)).toEqual([
      `implemented approval-ledger:sk-0001`,
      `merged approval-ledger:sk-0001`,
      "verified release:v1.0.0",
      `verified approval-ledger:sk-0001/interactionProof/1`,
      "published release:v1.0.0",
      `published approval-ledger:sk-0001/interactionProof/1`,
    ]);
    expect(record.record?.retained).toMatchObject([
      {
        entry: "sk-0001",
        nextBoundary: "after the next release",
        owner: ROLES.coordinator,
        reason: "Consumer adoption",
        source: "approval-ledger",
      },
    ]);
    expect(record.holds).toEqual([
      { id: "approval-ledger:hold-a", owner: ROLES.coordinator, reason: "Phase boundary" },
    ]);
    const tech = workShow(live(made), { id: "sg-0001", worktree: made.game }).record;
    expect(tech?.retained).toMatchObject([
      {
        nextBoundary: "next scheduled review",
        owner: ROLES.tech,
        reason: "Interaction proof missing",
      },
    ]);
    expect(tech?.state).toBe("recorded");
    // A covering imported hold refuses the start; import released nothing.
    expect(() => workStart(live(made, IDS.kit), {}, { id: "sk-0001", worktree: made.kit })).toThrow(
      new StoreError("work-held"),
    );
    const again = importApprovalLedger(
      context(IDS.coordinator),
      {},
      {
        dryRun: false,
        file: made.file,
      },
    );
    expect(again.events).toEqual({
      evidence: { insert: 0, unchanged: 7 },
      holds: { insert: 0, unchanged: 4 },
      retained: { insert: 0, unchanged: 2 },
    });
    const store = Store.forLayout(loadLayout(made.root));
    expect(store.events({ kinds: ["hold.imported"] }).map((event) => event.payload.owner)).toEqual([
      ROLES.coordinator,
      null,
      ROLES.coordinator,
      ROLES.art,
    ]);
    expect(store.events().filter((event) => /^hold\.(?!imported)/.test(event.kind))).toEqual([]);
    store.close();
  });

  it("runs as store import through the CLI and refuses an unknown format", async () => {
    const made = fixture();
    const io = liveIo(made, made.base);
    const exit = await main(io, [
      "--root",
      made.root,
      "store",
      "import",
      "--approval-ledger",
      "approval-ledger.json",
      "--dry-run",
    ]);
    expect(exit, io.output().err).toBe(EXIT_OK);
    expect(JSON.parse(io.output().out)).toMatchObject({ kind: "approval-ledger-import" });
    writeFileSync(made.file, JSON.stringify({ entries: [], schemaVersion: 2 }));
    const refused = liveIo(made, made.base);
    expect(
      await main(refused, [
        "--root",
        made.root,
        "store",
        "import",
        "--approval-ledger",
        made.file,
        "--dry-run",
      ]),
    ).toBe(EXIT_INVALID);
    expect(refused.output().err).toBe("coordination-kit: approval-ledger-invalid\n");
  });
});
