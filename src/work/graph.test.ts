import { describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { EXIT_INVALID, EXIT_OK } from "../io.ts";
import { loadLayout } from "../layout.ts";
import { Store } from "../store/db.ts";
import { workEvidence, workStart } from "./live.ts";
import { GAME, IDS, KIT, live, liveFixture, liveIo, ROLES, workFile } from "./testLive.ts";

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
  // The decision records of the store, as their projection holds them.
  const store = Store.forLayout(loadLayout(made.root));
  store.db.exec(
    `CREATE TABLE decisions (id TEXT PRIMARY KEY, work TEXT, question TEXT, by TEXT, at TEXT,
       role TEXT, supersedes TEXT, text TEXT)`,
  );
  store.db
    .prepare("INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("sk-0002/D2", "sk-0002", "q-sample-kit-2", "user", "2026-11-06", KIT, "D1", "Shard it.");
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
    expect(result.json.index).toEqual({ at: null, status: "live" });
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

  it("stores a derived index whose deletion loses nothing", async () => {
    const made = fixture();
    const live = await run(made, "graph");
    const indexed = await run(made, "graph", "index");
    expect(indexed.exit, indexed.err).toBe(EXIT_OK);
    expect(indexed.json).toMatchObject({ kind: "graph-index", repositories: 3, unavailable: [] });
    const stored = await run(made, "graph");
    expect(stored.json.index.status).toBe("stored");
    expect(stored.json.edges).toEqual(live.json.edges);
    expect(stored.json.nodes).toEqual(live.json.nodes);
    const store = Store.forLayout(loadLayout(made.root));
    store.db.exec("DROP TABLE edges; DROP TABLE graph_nodes; DROP TABLE graph_index;");
    expect(store.verify().events).toBeGreaterThan(0);
    store.close();
    const rebuilt = await run(made, "graph");
    expect(rebuilt.json.index.status).toBe("live");
    expect(rebuilt.json.edges).toEqual(live.json.edges);
  });
});
