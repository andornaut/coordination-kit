import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../core/cli/io.ts";
import { loadLayout } from "../core/configuration/layout.ts";
import { TEST_CONTEXT, TEST_HOST } from "../core/testFixtures.ts";
import { readRegistry } from "../registry/store.ts";
import { Store } from "../store/db.ts";
import { releasePolicyHold, setPolicyHold } from "../store/decisions/policyHolds.ts";
import {
  answerQuestion,
  listDecisions,
  openQuestion,
  recordQuestionAnswer,
  releaseHold,
  setHold,
} from "../store/decisions/questions.ts";
import { StoreError } from "../store/types.ts";
import {
  workBlock,
  workEvidence,
  workFinish,
  workHistoryOf,
  workReady,
  workShow,
  workStart,
  workUnblock,
} from "./live.ts";
import {
  commit,
  GAME,
  git,
  IDS,
  KIT,
  live,
  liveFixture,
  liveIo,
  ROLES,
  workFile,
} from "./testLive.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function code(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof StoreError ? error.code : String(error);
  }
}

function kitFixture() {
  return liveFixture({
    game: {
      "sg-0001": workFile("sg-0001", "Tech item", "approved"),
      "sg-0002": workFile("sg-0002", "Art item", "approved", { design: "art" }),
      "sg-0003": workFile("sg-0003", "Owned item", "approved", { owner: ROLES.art }),
    },
    kit: {
      "sk-0001": workFile("sk-0001", "Approved item", "approved"),
      "sk-0002": workFile("sk-0002", "Proposed item", "proposed"),
      "sk-0003": workFile("sk-0003", "Done item", "done"),
    },
  });
}

describe("work verbs", () => {
  it("lets only the owner of the work file's repository write", () => {
    const fixture = kitFixture();
    const input = { id: "sk-0001", worktree: fixture.kit };
    expect(code(() => workStart(live(fixture), {}, input))).toBe("caller-unidentified");
    expect(code(() => workStart(live(fixture, IDS.coordinator), {}, input))).toBe("not-owner");
    expect(code(() => workStart(live(fixture, IDS.tech), {}, input))).toBe("not-owner");
    const started = workStart(live(fixture, IDS.kit), {}, input);
    expect(started).toMatchObject({
      duplicate: false,
      owner: KIT,
      record: { owner: KIT, repository: KIT, state: "started" },
      repository: KIT,
    });
    expect(workStart(live(fixture, IDS.kit), {}, input).duplicate).toBe(true);
    // In a game, the design area names the owner unless the front matter says otherwise.
    const game = (id: string) => ({ id, worktree: fixture.game });
    expect(code(() => workStart(live(fixture, IDS.art), {}, game("sg-0001")))).toBe("not-owner");
    expect(workStart(live(fixture, IDS.tech), {}, game("sg-0001")).owner).toBe(ROLES.tech);
    expect(code(() => workStart(live(fixture, IDS.tech), {}, game("sg-0002")))).toBe("not-owner");
    expect(workStart(live(fixture, IDS.art), {}, game("sg-0002")).owner).toBe(ROLES.art);
    expect(workStart(live(fixture, IDS.art), {}, game("sg-0003")).owner).toBe(ROLES.art);
    expect(
      code(() => workStart(live(fixture, IDS.kit), {}, { ...input, worktree: fixture.base })),
    ).toBe("repository-unavailable");
  });

  it("starts only an item approved on local main, not the working tree", () => {
    const fixture = kitFixture();
    const kit = live(fixture, IDS.kit);
    expect(code(() => workStart(kit, {}, { id: "sk-0002", worktree: fixture.kit }))).toBe(
      "work-not-approved",
    );
    expect(code(() => workStart(kit, {}, { id: "sk-0003", worktree: fixture.kit }))).toBe(
      "work-not-approved",
    );
    expect(code(() => workStart(kit, {}, { id: "sk-0009", worktree: fixture.kit }))).toBe(
      "work-file-missing",
    );
    // An approval only on a branch does not count.
    commit(fixture.kit, "Branch point", {});
    git(fixture.kit, "checkout", "-q", "-b", "feature");
    commit(fixture.kit, "Approve on a branch", {
      "docs/work/sk-0002.md": workFile("sk-0002", "Proposed item", "approved"),
    });
    expect(code(() => workStart(kit, {}, { id: "sk-0002", worktree: fixture.kit }))).toBe(
      "work-not-approved",
    );
    git(fixture.kit, "checkout", "-q", "main");
    git(fixture.kit, "merge", "-q", "--ff-only", "feature");
    expect(workStart(kit, {}, { id: "sk-0002", worktree: fixture.kit }).record.state).toBe(
      "started",
    );
  });

  it("refuses a start that a hold covers", () => {
    const fixture = kitFixture();
    const context = {
      ...live(fixture, IDS.kit),
      holds: () => [{ id: "hold-1", owner: ROLES.coordinator, reason: "Paused" }],
    };
    expect(code(() => workStart(context, {}, { id: "sk-0001", worktree: fixture.kit }))).toBe(
      "work-held",
    );
  });

  it("reads the store's hold records: work, role and app scopes, set and imported", () => {
    const fixture = kitFixture();
    const kit = live(fixture, IDS.kit);
    const tech = live(fixture, IDS.tech);
    const sk = { id: "sk-0001", worktree: fixture.kit };
    const sg = { id: "sg-0001", worktree: fixture.game };
    const store = Store.forLayout(TEST_CONTEXT, loadLayout(fixture.root));
    const coordinator = { nativeId: IDS.coordinator, role: ROLES.coordinator };
    const kitActor = { nativeId: IDS.kit, role: KIT };
    const holdIds = () => workShow(kit, sk).holds.map((hold) => hold.id);
    setHold(store, coordinator, { id: "h-work", reason: "Waiting", scope: "work:sk-0001" });
    setHold(store, kitActor, { id: "h-role", reason: "Paused", scope: "role" });
    setHold(store, coordinator, { id: "h-app", reason: "Cutover", scope: `app:${GAME}` });
    setHold(store, coordinator, { id: "h-other", reason: "Other", scope: "work:sk-0002" });
    store.append({
      actor: coordinator,
      key: "hold.imported:approval-ledger:test",
      kind: "hold.imported",
      payload: {
        entries: ["entry-1"],
        id: "approval-ledger:hold-1",
        owner: null,
        reason: "Imported",
        source: "approval-ledger",
        state: "preserved",
        work: [{ id: "sk-0001", repository: KIT }],
      },
    });
    expect(holdIds()).toEqual(["h-work", "h-role", "approval-ledger:hold-1"]);
    expect(code(() => workStart(kit, {}, sk))).toBe("work-held");
    expect(code(() => workStart(tech, {}, sg))).toBe("work-held");
    releaseHold(store, coordinator, "h-app");
    expect(workStart(tech, {}, sg).record.state).toBe("started");
    releaseHold(store, coordinator, "h-work");
    releaseHold(store, kitActor, "h-role");
    // The imported hold has no owner, so no binding can release it and it still covers the item.
    expect(code(() => releaseHold(store, kitActor, "approval-ledger:hold-1"))).toBe("not-owner");
    expect(code(() => workStart(kit, {}, sk))).toBe("work-held");
    store.close();
  });

  it("checks exact policy targets before start and keeps other work available", () => {
    const fixture = kitFixture();
    const layout = loadLayout(fixture.root);
    const store = Store.forLayout(TEST_CONTEXT, layout);
    const authority = { layout, registry: readRegistry(layout) };
    const actor = { nativeId: IDS.coordinator, role: ROLES.coordinator };
    const item = (id: string) => ({ id, worktree: fixture.game });
    const set = (id: string, scope: string) =>
      setPolicyHold(store, authority, actor, {
        approval: "request-1",
        id,
        reason: "User paused.",
        scope,
      });
    set("policy-exact", `work:${GAME}:sg-0001`);
    set("policy-app", `app:${GAME}`);
    set("policy-art", `role:${ROLES.art}`);
    expect(workShow(live(fixture), item("sg-0001")).holds).toMatchObject([
      { id: "policy-exact", owner: ROLES.coordinator, policy: { target: { repository: GAME } } },
      { id: "policy-app" },
    ]);
    expect(code(() => workStart(live(fixture, IDS.tech), {}, item("sg-0001")))).toBe("work-held");
    expect(code(() => workStart(live(fixture, IDS.art), {}, item("sg-0002")))).toBe("work-held");
    expect(
      workStart(live(fixture, IDS.kit), {}, { id: "sk-0001", worktree: fixture.kit }).record.state,
    ).toBe("started");
    releasePolicyHold(store, authority, actor, { approval: "request-2", id: "policy-app" });
    expect(code(() => workStart(live(fixture, IDS.tech), {}, item("sg-0001")))).toBe("work-held");
    releasePolicyHold(store, authority, actor, { approval: "request-3", id: "policy-exact" });
    expect(workStart(live(fixture, IDS.tech), {}, item("sg-0001")).record.state).toBe("started");
    expect(code(() => workStart(live(fixture, IDS.art), {}, item("sg-0002")))).toBe("work-held");
    const before = workShow(live(fixture), item("sg-0002")).holds;
    store.rebuild();
    expect(workShow(live(fixture), item("sg-0002")).holds).toEqual(before);
    store.close();
  });

  it("fences only exact Codex question dependencies and releases them on the explicit answer", () => {
    const fixture = kitFixture();
    const tech = live(fixture, IDS.tech);
    const art = live(fixture, IDS.art);
    const host = Store.forLayout(TEST_CONTEXT, loadLayout(fixture.root));
    const actor = { nativeId: IDS.art, role: ROLES.art };
    const blocked = { id: "sg-0001", worktree: fixture.game };
    const independent = { id: "sg-0002", worktree: fixture.game };
    openQuestion(host, actor, {
      codex: { dependsOn: [{ id: blocked.id, repository: GAME }], thread: IDS.art },
      id: "q-required",
      title: "Which technical option?",
    });
    expect(workShow(tech, blocked).pendingQuestions).toEqual(["q-required"]);
    expect(code(() => workStart(tech, {}, blocked))).toBe("work-question-pending");
    expect(workStart(art, {}, independent).record.state).toBe("started");
    recordQuestionAnswer(TEST_HOST, host, actor, "q-required", {
      text: "Use the first option.",
      work: "sg-0002",
    });
    expect(workStart(tech, {}, blocked).record.state).toBe("started");
    host.close();
  });

  it("blocks, unblocks, readies and records evidence", () => {
    const fixture = kitFixture();
    const kit = live(fixture, IDS.kit);
    const input = { id: "sk-0001", worktree: fixture.kit };
    expect(code(() => workReady(kit, {}, input))).toBe("work-not-started");
    workStart(kit, {}, input);
    const blocked = workBlock(
      kit,
      {},
      { ...input, owner: ROLES.coordinator, reason: "Needs a pin" },
    );
    expect(blocked.record).toMatchObject({
      block: { owner: ROLES.coordinator, reason: "Needs a pin" },
      state: "blocked",
    });
    expect(
      workBlock(kit, {}, { ...input, owner: ROLES.coordinator, reason: "Needs a pin" }).duplicate,
    ).toBe(true);
    expect(code(() => workBlock(kit, {}, { ...input, owner: "nobody", reason: "x" }))).toBe(
      "owner-unregistered",
    );
    expect(code(() => workReady(kit, {}, input))).toBe("work-blocked");
    expect(workUnblock(kit, {}, input).record).toMatchObject({ block: null, state: "started" });
    expect(workUnblock(kit, {}, input).duplicate).toBe(true);
    expect(workReady(kit, {}, input).record.state).toBe("ready");
    expect(workReady(kit, {}, input).duplicate).toBe(true);
    const evidence = workEvidence(
      kit,
      {},
      { ...input, ref: "ci:run-1", sha: SHA, stage: "merged" },
    );
    expect(evidence.record.evidence).toMatchObject([
      { actor: KIT, ref: "ci:run-1", sha: SHA, source: null, stage: "merged" },
    ]);
    expect(
      workEvidence(kit, {}, { ...input, ref: "ci:run-1", sha: SHA.toUpperCase(), stage: "merged" })
        .duplicate,
    ).toBe(true);
    expect(code(() => workEvidence(kit, {}, { ...input, sha: "nothex", stage: "merged" }))).toBe(
      "invalid-sha",
    );
    expect(
      code(() =>
        workEvidence(live(fixture, IDS.tech), {}, { ...input, sha: SHA, stage: "merged" }),
      ),
    ).toBe("not-owner");
    const history = workHistoryOf(live(fixture), input).events.map((event) => event.kind);
    expect(history).toEqual([
      "work.started",
      "work.blocked",
      "work.unblocked",
      "work.ready",
      "work.evidence",
    ]);
  });

  it("finishes only an item that is done on main", () => {
    const fixture = kitFixture();
    const kit = live(fixture, IDS.kit);
    const input = { id: "sk-0001", worktree: fixture.kit };
    workStart(kit, {}, input);
    expect(code(() => workFinish(kit, {}, input))).toBe("work-not-done");
    commit(fixture.kit, "Land sk-0001", {
      "docs/work/sk-0001.md": workFile("sk-0001", "Approved item", "done"),
    });
    const finished = workFinish(kit, {}, input);
    expect(finished.record).toMatchObject({ state: "finished" });
    expect(finished.record.finishedAt).not.toBeNull();
    expect(workFinish(kit, {}, input).duplicate).toBe(true);
    expect(code(() => workBlock(kit, {}, { ...input, reason: "Late" }))).toBe("work-finished");
    // Acceptance stages continue after finish.
    expect(
      workEvidence(kit, {}, { ...input, sha: SHA, stage: "published" }).record.evidence,
    ).toHaveLength(1);
    expect(
      workFinish(kit, {}, { id: "sk-0003", worktree: fixture.kit }).record.startedAt,
    ).toBeNull();
  });

  it.each([
    {
      expected: { finishedStatus: "superseded", successors: ["sk-0012"] },
      files: { "sk-0012": workFile("sk-0012", "Successor", "approved", { supersedes: "sk-0011" }) },
      name: "superseded by one successor",
      payload: { status: "superseded", successors: ["sk-0012"] },
      status: "superseded",
    },
    {
      expected: { finishedStatus: "superseded", successors: ["sk-0012", "sk-0013"] },
      files: {
        "sk-0012": workFile("sk-0012", "First", "done", { supersedes: ["sk-0009", "sk-0011"] }),
        "sk-0013": workFile("sk-0013", "Second", "approved", { supersedes: ["sk-0011"] }),
        // Names the ID only in its body, and supersedes a longer ID that shares the prefix.
        "sk-0014": workFile("sk-0014", "Mentions sk-0011", "approved", { supersedes: "sk-00111" }),
      },
      name: "superseded by a list",
      payload: { status: "superseded", successors: ["sk-0012", "sk-0013"] },
      status: "superseded",
    },
    {
      expected: { finishedStatus: "cancelled", successors: [] },
      files: {},
      name: "cancelled",
      payload: { status: "cancelled" },
      status: "cancelled",
    },
    {
      expected: { finishedStatus: "done", successors: [] },
      files: {},
      name: "done",
      payload: {},
      status: "done",
    },
  ])("finishes a ready item whose work file is $name", ({ expected, files, payload, status }) => {
    const fixture = liveFixture({
      kit: { "sk-0011": workFile("sk-0011", "Replaced item", "approved"), ...files },
    });
    const kit = live(fixture, IDS.kit);
    const input = { id: "sk-0011", worktree: fixture.kit };
    workStart(kit, {}, input);
    workReady(kit, {}, input);
    commit(fixture.kit, "Close sk-0011", {
      "docs/work/sk-0011.md": workFile("sk-0011", "Replaced item", status),
    });
    const finished = workFinish(kit, {}, input);
    expect(finished.workFile.status).toBe(status);
    expect(finished.record).toMatchObject({ state: "finished", ...expected });
    expect(workFinish(kit, {}, input).duplicate).toBe(true);
    const event = workHistoryOf(live(fixture), input).events.at(-1)!;
    expect(event.kind).toBe("work.finished");
    // A done finish keeps the payload written before finish recorded a status.
    expect(event.payload).toEqual({ id: "sk-0011", owner: KIT, repository: KIT, ...payload });
    expect(workShow(live(fixture), input).record).toMatchObject(expected);
  });

  it("refuses a superseded item that no work file on main supersedes", () => {
    const fixture = liveFixture({
      kit: {
        "sk-0011": workFile("sk-0011", "Replaced item", "superseded"),
        "sk-0012": workFile("sk-0012", "Related", "approved", { related: ["sk-0011"] }),
      },
    });
    const kit = live(fixture, IDS.kit);
    const input = { id: "sk-0011", worktree: fixture.kit };
    // A successor only in the working tree does not count: finish reads `main`.
    writeFileSync(
      join(fixture.kit, "docs/work/sk-0013.md"),
      workFile("sk-0013", "Uncommitted", "approved", { supersedes: "sk-0011" }),
    );
    expect(code(() => workFinish(kit, {}, input))).toBe("successor-missing");
    expect(workShow(live(fixture), input).record).toBeNull();
  });

  it.each(["proposed", "approved", "declined"])("refuses to finish a %s item", (status) => {
    const fixture = liveFixture({ kit: { "sk-0011": workFile("sk-0011", "Open item", status) } });
    expect(
      code(() => workFinish(live(fixture, IDS.kit), {}, { id: "sk-0011", worktree: fixture.kit })),
    ).toBe("work-not-done");
  });

  it("links a cross-role child to its parent as a parent edge", () => {
    const fixture = kitFixture();
    const child = workStart(
      live(fixture, IDS.kit),
      {},
      {
        id: "sk-0001",
        parent: `${GAME}:sg-0001`,
        worktree: fixture.kit,
      },
    );
    expect(child.record.parent).toEqual({ id: "sg-0001", repository: GAME });
    expect(child.owner).toBe(KIT);
    expect(
      code(() =>
        workStart(
          live(fixture, IDS.kit),
          {},
          {
            id: "sk-0001",
            parent: `${GAME}:sg-0002`,
            worktree: fixture.kit,
          },
        ),
      ),
    ).toBe("parent-conflict");
    expect(
      code(() =>
        workStart(
          live(fixture, IDS.tech),
          {},
          {
            id: "sg-0001",
            parent: `${KIT}:sk-0009`,
            worktree: fixture.game,
          },
        ),
      ),
    ).toBe("parent-missing");
    expect(
      code(() =>
        workStart(
          live(fixture, IDS.tech),
          {},
          {
            id: "sg-0001",
            parent: "elsewhere:sk-0001",
            worktree: fixture.game,
          },
        ),
      ),
    ).toBe("repository-unregistered");
    const parent = workShow(live(fixture), { id: "sg-0001", worktree: fixture.game });
    expect(parent.record).toBeNull();
    workStart(live(fixture, IDS.tech), {}, { id: "sg-0001", worktree: fixture.game });
    expect(
      workShow(live(fixture), { id: "sg-0001", worktree: fixture.game }).record?.children,
    ).toEqual([{ id: "sk-0001", repository: KIT }]);
  });

  it("rebuilds the work projection from the events", () => {
    const fixture = kitFixture();
    const kit = live(fixture, IDS.kit);
    const input = { id: "sk-0001", worktree: fixture.kit };
    workStart(kit, {}, input);
    workBlock(kit, {}, { ...input, reason: "Waiting" });
    workEvidence(kit, {}, { ...input, sha: SHA, stage: "implemented" });
    const before = workShow(live(fixture), input).record;
    const store = Store.forLayout(TEST_CONTEXT, loadLayout(fixture.root));
    store.rebuild();
    store.close();
    expect(workShow(live(fixture), input).record).toEqual(before);
  });
});

describe("work commands", () => {
  it("runs start, evidence, show and history through the CLI with JSON output", async () => {
    const fixture = kitFixture();
    const run = async (nativeId: string | undefined, ...argv: string[]) => {
      const io = liveIo(fixture, fixture.kit, nativeId);
      const exit = await main(io, argv);
      return { exit, ...io.output() };
    };
    const started = await run(IDS.kit, "work", "start", "sk-0001");
    expect(started.exit, started.err).toBe(EXIT_OK);
    expect(JSON.parse(started.out)).toMatchObject({ record: { state: "started" }, schema: 1 });
    const evidence = await run(
      IDS.kit,
      "work",
      "evidence",
      "sk-0001",
      "--stage",
      "implemented",
      "--sha",
      SHA,
    );
    expect(evidence.exit, evidence.err).toBe(EXIT_OK);
    const refused = await run(IDS.tech, "work", "ready", "sk-0001");
    expect(refused).toMatchObject({ err: "coordination-kit: not-owner\n", exit: EXIT_INVALID });
    expect(
      (await run(IDS.kit, "work", "evidence", "sk-0001", "--stage", "landed", "--sha", SHA)).exit,
    ).toBe(EXIT_USAGE);
    expect((await run(IDS.kit, "work", "start")).exit).toBe(EXIT_USAGE);
    const show = await run(undefined, "work", "show", "sk-0001");
    expect(JSON.parse(show.out)).toMatchObject({
      holds: [],
      owner: KIT,
      record: { evidence: [{ stage: "implemented" }] },
      workFile: { status: "approved", title: "Approved item" },
    });
    const history = await run(undefined, "work", "history", "sk-0001");
    expect(
      (JSON.parse(history.out) as { events: { kind: string }[] }).events.map((e) => e.kind),
    ).toEqual(["work.started", "work.evidence"]);
    const unset = liveIo(fixture, fixture.kit, IDS.kit);
    const exit = await main({ ...unset, env: { PATH: process.env.PATH } }, [
      "work",
      "show",
      "sk-0001",
    ]);
    expect(exit).toBe(EXIT_INVALID);
    expect(unset.output().err).toBe("coordination-kit: coordinator-unset\n");
  });
});

describe("work check --decisions", () => {
  it("reports store decisions missing from the work files", async () => {
    const fixture = liveFixture({
      kit: {
        "sk-0001": workFile("sk-0001", "Approved item", "approved", {
          decisions: ["- D1 (user, 2026-11-18): Recorded."],
        }),
      },
    });
    const store = Store.forLayout(TEST_CONTEXT, loadLayout(fixture.root));
    // Store decisions through the question records: D1 is in the file, D2 only in the store, and
    // zz-0001 belongs to no repository's work files.
    const actor = { nativeId: IDS.kit, role: KIT };
    for (const [id, work, text] of [
      ["q-1", "sk-0001", "Recorded."],
      ["q-2", "sk-0001", "Only in the store."],
      ["q-3", "zz-0001", "Another repository."],
    ] as const) {
      openQuestion(store, actor, { id, title: "Decide?" });
      answerQuestion(TEST_HOST, store, actor, id, { text, work });
    }
    expect(listDecisions(store).map((decision) => decision.id)).toEqual([
      "sk-0001/D1",
      "sk-0001/D2",
      "zz-0001/D1",
    ]);
    store.close();
    const io = liveIo(fixture, fixture.kit);
    expect(await main(io, ["work", "check", "--decisions"])).toBe(EXIT_INVALID);
    const findings = (
      JSON.parse(io.output().out) as { findings: { code: string; path: string; message: string }[] }
    ).findings.filter((finding) => finding.code.startsWith("decision"));
    expect(findings).toEqual([
      {
        code: "decision-unrecorded",
        message: "store decision sk-0001/D2 is not in the work file",
        path: "docs/work/sk-0001.md",
      },
    ]);
    const unset = liveIo(fixture, fixture.kit);
    await main({ ...unset, env: { PATH: process.env.PATH } }, ["work", "check", "--decisions"]);
    expect(unset.output().out).toContain('"code":"decisions-unavailable"');
  });
});
