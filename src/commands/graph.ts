// `graph`, `graph why` and `graph index` over the coordinator's registered repositories and the
// store. Each prints one JSON object (or DOT for `graph --format dot`); a refusal prints
// `coordination-kit: CODE` and exits 1, a usage error exits 2.
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type GitRunner, systemGit } from "../status/git.ts";
import { Store, storePath } from "../store/db.ts";
import { StoreError } from "../store/types.ts";
import {
  buildGraph,
  findDecision,
  findWork,
  type Graph,
  graphDot,
  graphJson,
  neighbourhood,
  readIndex,
  why,
  writeIndex,
} from "../work/graph.ts";
import { type Coordinator, openCoordinator } from "../work/live.ts";

export const GRAPH_OPTIONS = {
  depth: { type: "string" },
  format: { type: "string" },
  work: { type: "string" },
} as const;
export const GRAPH_WHY_OPTIONS = { decision: { type: "string" } } as const;
export const GRAPH_INDEX_OPTIONS = {} as const;

class Usage extends Error {}

/** The store when its file exists, else null; nothing is created. */
function openStore(coordinator: Coordinator): Store | null {
  let path: string;
  try {
    path = storePath(coordinator.layout);
  } catch {
    return null;
  }
  return existsSync(path) ? Store.open(path) : null;
}

interface Loaded {
  readonly graph: Graph;
  readonly index: { readonly status: "stored" | "live"; readonly at: string | null };
}

function load(git: GitRunner, coordinator: Coordinator): Loaded {
  const store = openStore(coordinator);
  try {
    const stored = store === null ? null : readIndex(store);
    if (stored !== null) {
      return { graph: stored, index: { at: stored.at, status: "stored" } };
    }
    return { graph: buildGraph(git, coordinator, store), index: { at: null, status: "live" } };
  } finally {
    store?.close();
  }
}

function run(
  io: Io,
  command: string,
  args: string[],
  options: Record<string, { readonly type: "string" | "boolean" }>,
  action: (values: Record<string, string | boolean | undefined>) => string,
): number {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({ args, options, strict: true }).values as typeof values;
    if (Object.values(values).some((value) => typeof value === "string" && value.trim() === "")) {
      throw new Usage();
    }
  } catch {
    io.err(`coordination-kit: invalid_graph_options (${command})\n`);
    return EXIT_USAGE;
  }
  try {
    io.out(action(values));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof Usage) {
      io.err(`coordination-kit: invalid_graph_options (${command})\n`);
      return EXIT_USAGE;
    }
    const code =
      error instanceof StoreError && /^[a-z][a-z-]{0,63}$/.test(error.code)
        ? error.code
        : "graph_operation_failed";
    io.err(`coordination-kit: ${code}\n`);
    return EXIT_INVALID;
  }
}

export const graph: Handler = (io, root, args) =>
  run(io, "graph", args, GRAPH_OPTIONS, (values) => {
    const format = (values.format as string | undefined) ?? "json";
    const depthText = values.depth as string | undefined;
    if (
      !["json", "dot"].includes(format) ||
      (depthText !== undefined && !/^(?:[0-9]|[1-9][0-9])$/.test(depthText))
    ) {
      throw new Usage();
    }
    const git = systemGit(io.env);
    const loaded = load(git, openCoordinator(git, root));
    const work = values.work as string | undefined;
    const selected =
      work === undefined
        ? loaded.graph
        : neighbourhood(loaded.graph, findWork(loaded.graph, work), Number(depthText ?? 2));
    if (format === "dot") {
      return graphDot(selected);
    }
    return `${JSON.stringify({
      index: loaded.index,
      kind: "graph",
      schema: 1,
      unavailable: loaded.graph.unavailable,
      ...graphJson(selected),
    })}\n`;
  });

export const graphWhy: Handler = (io, root, args) =>
  run(io, "graph why", args, GRAPH_WHY_OPTIONS, (values) => {
    const decision = values.decision as string | undefined;
    if (decision === undefined) {
      throw new Usage();
    }
    const git = systemGit(io.env);
    const loaded = load(git, openCoordinator(git, root));
    return `${JSON.stringify({
      index: loaded.index,
      kind: "graph-why",
      schema: 1,
      unavailable: loaded.graph.unavailable,
      ...why(loaded.graph, findDecision(loaded.graph, decision)),
    })}\n`;
  });

export const graphIndex: Handler = (io, root, args) =>
  run(io, "graph index", args, GRAPH_INDEX_OPTIONS, () => {
    const git = systemGit(io.env);
    const coordinator = openCoordinator(git, root);
    const store = Store.forLayout(coordinator.layout);
    try {
      const built = buildGraph(git, coordinator, store);
      writeIndex(store, built);
      return `${JSON.stringify({
        edges: built.edges.length,
        kind: "graph-index",
        nodes: built.nodes.size,
        repositories: built.repositories.length,
        schema: 1,
        unavailable: built.unavailable,
      })}\n`;
    } finally {
      store.close();
    }
  });
