import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../io.ts";
import { loadLayout } from "../layout.ts";
import { Store } from "../store/db.ts";
import { activateMigration, prepareMigration } from "../store/files/migration.ts";
import { answerQuestion, openQuestion } from "../store/questions.ts";
import { workEvidence, workStart } from "./live.ts";
import { commit, GAME, IDS, KIT, live, liveFixture, liveIo, ROLES, workFile } from "./testLive.ts";

const SHA = "89abcdef0123456789abcdef0123456789abcdef";

function fixture() {
  const made = liveFixture({
    game: { "sg-0001": workFile("sg-0001", "Parent item", "approved") },
    kit: {
      "sk-0001": workFile("sk-0001", "First approach", "superseded", {
        approved: "user, 2026-11-02, first",
        decisions: [
          "- D1 (user, 2026-11-02): Use a queue.",
          "- D2 (user, 2026-11-03; supersedes D1): Use a log.",
          "- D3 (user, 2026-11-04; answers q-sample-kit-1; supersedes D2): Use a table.",
          "- Prose about the decisions.",
        ],
      }),
      "sk-0002": workFile("sk-0002", "Second approach", "approved", {
        approved: "user, 2026-11-05, second",
        decisions: ["- D1 (user, 2026-11-05; supersedes sk-0001/D3): Use one store."],
        related: ["sk-0001"],
        supersedes: "sk-0001",
      }),
    },
  });
  workStart(
    live(made, IDS.kit),
    {},
    {
      id: "sk-0002",
      parent: `${GAME}:sg-0001`,
      worktree: made.kit,
    },
  );
  workEvidence(
    live(made, IDS.kit),
    {},
    {
      id: "sk-0002",
      sha: SHA,
      stage: "implemented",
      worktree: made.kit,
    },
  );
  // A decision recorded through the question records, beside the work file's own D1.
  const store = Store.forLayout(loadLayout(made.root), { now: () => "2026-11-06T12:00:00.000Z" });
  const actor = { nativeId: IDS.kit, role: KIT };
  openQuestion(store, actor, { id: "q-sample-kit-2", title: "Shard the store?" });
  answerQuestion(store, actor, "q-sample-kit-2", {
    fileNumbers: [1],
    supersedes: "D1",
    text: "Shard it.",
    work: "sk-0002",
  });
  store.close();
  return made;
}

async function run(made: ReturnType<typeof fixture>, ...argv: string[]) {
  const io = liveIo(made, made.base);
  const exit = await main(io, ["--root", made.root, ...argv]);
  const { err, out } = io.output();
  return {
    err,
    exit,
    json: exit === EXIT_OK && !argv.includes("dot") ? JSON.parse(out) : null,
    out,
  };
}

describe("graph", () => {
  it("joins work files, decisions, questions, roles and store records by typed edges", async () => {
    const made = fixture();
    const result = await run(made, "graph");
    expect(result.exit, result.err).toBe(EXIT_OK);
    const edges = (result.json.edges as { kind: string; from: string; to: string }[]).map(
      (edge) => `${edge.kind} ${edge.from} ${edge.to}`,
    );
    expect(edges).toEqual(
      expect.arrayContaining([
        `decides decision:${KIT}:sk-0001/D1 work:${KIT}:sk-0001`,
        `supersedes decision:${KIT}:sk-0001/D2 decision:${KIT}:sk-0001/D1`,
        `answers decision:${KIT}:sk-0001/D3 question:q-sample-kit-1`,
        `supersedes decision:${KIT}:sk-0002/D1 decision:${KIT}:sk-0001/D3`,
        `supersedes work:${KIT}:sk-0002 work:${KIT}:sk-0001`,
        `related work:${KIT}:sk-0002 work:${KIT}:sk-0001`,
        `owned-by work:${KIT}:sk-0001 role:${KIT}`,
        `owned-by work:${GAME}:sg-0001 role:${ROLES.tech}`,
        `implements commit:${SHA} work:${KIT}:sk-0002`,
        `parent work:${KIT}:sk-0002 work:${GAME}:sg-0001`,
        `decides decision:${KIT}:sk-0002/D2 work:${KIT}:sk-0002`,
        `answers decision:${KIT}:sk-0002/D2 question:q-sample-kit-2`,
        `supersedes decision:${KIT}:sk-0002/D2 decision:${KIT}:sk-0002/D1`,
      ]),
    );
    expect(result.json.schema).toBe(2);
    expect(result.json).not.toHaveProperty("index");
    expect(edges.some((edge) => edge.includes("Prose"))).toBe(false);
  });

  it("answers why with the supersedes chain and each item's approval", async () => {
    const made = fixture();
    const result = await run(made, "graph", "why", "--decision", "sk-0001/D2");
    expect(result.exit, result.err).toBe(EXIT_OK);
    expect(result.json.decision).toMatchObject({
      approved: "user, 2026-11-02, first",
      by: "user",
      decision: `${KIT}:sk-0001/D2`,
      text: "Use a log.",
    });
    expect(result.json.supersedes.map((step: { decision: string }) => step.decision)).toEqual([
      `${KIT}:sk-0001/D1`,
    ]);
    expect(result.json.supersededBy).toMatchObject([
      { answers: "q-sample-kit-1", decision: `${KIT}:sk-0001/D3` },
      { approved: "user, 2026-11-05, second", decision: `${KIT}:sk-0002/D1` },
      { decision: `${KIT}:sk-0002/D2`, text: "Shard it." },
    ]);
    expect(result.json.current).toBe(`${KIT}:sk-0002/D2`);
    const unknown = await run(made, "graph", "why", "--decision", "sk-0001/D9");
    expect(unknown).toMatchObject({
      err: "coordination-kit: decision-unknown\n",
      exit: EXIT_INVALID,
    });
  });

  it("limits a work item's neighbourhood by depth and prints DOT", async () => {
    const made = fixture();
    const near = await run(made, "graph", "--work", "sg-0001", "--depth", "1");
    expect(near.exit, near.err).toBe(EXIT_OK);
    expect(near.json.nodes.map((node: { key: string }) => node.key).sort()).toEqual([
      `role:${ROLES.tech}`,
      `work:${GAME}:sg-0001`,
      `work:${KIT}:sk-0002`,
    ]);
    const dot = await run(made, "graph", "--work", `${KIT}:sk-0002`, "--format", "dot");
    expect(dot.exit, dot.err).toBe(EXIT_OK);
    expect(dot.out).toMatch(/^digraph coordination \{/);
    expect(dot.out).toContain(`"work:${KIT}:sk-0002" -> "work:${GAME}:sg-0001" [label="parent"];`);
    expect((await run(made, "graph", "--work", "sk-0404")).err).toBe(
      "coordination-kit: work-unknown\n",
    );
  });

  it("reads new Git decisions and store evidence while leaving an old cache untouched", async () => {
    const made = fixture();
    const layout = loadLayout(made.root);
    const { receipt } = prepareMigration(
      layout,
      join(made.base, "backup.db"),
      join(made.base, "restore.db"),
    );
    activateMigration(layout, receipt.id);
    const previous = await run(made, "graph");
    expect(previous.exit, previous.err).toBe(EXIT_OK);
    const cache = join(layout.varDir, "coordination", "graph-index.json");
    const bytes = JSON.stringify({
      at: "2026-11-06T12:00:00.000Z",
      edges: previous.json.edges,
      nodes: previous.json.nodes,
      repositories: [ROLES.coordinator, GAME, KIT],
      schema: 1,
      unavailable: previous.json.unavailable,
    });
    writeFileSync(cache, bytes);
    const before = statSync(cache, { bigint: true });

    commit(made.kit, "Record a new decision", {
      "docs/work/sk-0003.md": workFile("sk-0003", "Third approach", "approved", {
        decisions: ["- D1 (user, 2026-11-07; supersedes sk-0002/D2): Use one journal."],
      }),
    });
    const context = live(made, IDS.kit);
    workStart(context, {}, { id: "sk-0003", worktree: made.kit });
    workEvidence(
      context,
      {},
      { id: "sk-0003", sha: SHA, stage: "implemented", worktree: made.kit },
    );

    const head = () => {
      const store = Store.readLayout(layout)!;
      try {
        return store.head();
      } finally {
        store.close();
      }
    };
    const written = head();
    const graph = await run(made, "graph");
    expect(graph.exit, graph.err).toBe(EXIT_OK);
    expect(graph.json.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: `commit:${SHA}`,
          kind: "implements",
          source: "store",
          to: `work:${KIT}:sk-0003`,
        }),
      ]),
    );

    const why = await run(made, "graph", "why", "--decision", "sk-0002/D2");
    expect(why.exit, why.err).toBe(EXIT_OK);
    expect(why.json.current).toBe(`${KIT}:sk-0003/D1`);
    expect(why.json.schema).toBe(2);
    expect(why.json).not.toHaveProperty("index");
    expect((await run(made, "graph", "index")).exit).toBe(EXIT_USAGE);

    expect(head()).toEqual(written);
    expect(readFileSync(cache, "utf8")).toBe(bytes);
    const after = statSync(cache, { bigint: true });
    expect({ ino: after.ino, mtime: after.mtimeNs }).toEqual({
      ino: before.ino,
      mtime: before.mtimeNs,
    });
  });

  it("reports unavailable sources", async () => {
    const made = fixture();
    renameSync(made.game, join(made.base, "unavailable-game"));
    const graph = await run(made, "graph");
    expect(graph.exit, graph.err).toBe(EXIT_OK);
    expect(graph.json.unavailable).toEqual([GAME]);
  });
});
