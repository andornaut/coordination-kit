// Decision graph queries over the coordinator's registered repositories and the
// store. Each prints one JSON object (or DOT for `graph --format dot`); a refusal prints
// `coordination-kit: CODE` and exits 1, a usage error exits 2.
import { parseArgs } from "node:util";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { type GitRunner, systemGit } from "../status/git.ts";
import { Store } from "../store/db.ts";
import { StoreError } from "../store/types.ts";
import {
  buildGraph,
  findDecision,
  findWork,
  type Graph,
  graphDot,
  graphJson,
  neighbourhood,
  why,
} from "../work/graph.ts";
import { type Coordinator, openCoordinator } from "../work/live.ts";

export const GRAPH_OPTIONS = {
  depth: { type: "string" },
  format: { type: "string" },
  work: { type: "string" },
} as const;
export const GRAPH_WHY_OPTIONS = { decision: { type: "string" } } as const;

class Usage extends Error {}

function load(git: GitRunner, coordinator: Coordinator): Graph {
  const store = Store.readLayout(coordinator.layout);
  try {
    return buildGraph(git, coordinator, store);
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
    const current = load(git, openCoordinator(git, root));
    const work = values.work as string | undefined;
    const selected =
      work === undefined
        ? current
        : neighbourhood(current, findWork(current, work), Number(depthText ?? 2));
    if (format === "dot") {
      return graphDot(selected);
    }
    return `${JSON.stringify({
      kind: "graph",
      schema: 2,
      unavailable: current.unavailable,
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
    const current = load(git, openCoordinator(git, root));
    return `${JSON.stringify({
      kind: "graph-why",
      schema: 2,
      unavailable: current.unavailable,
      ...why(current, findDecision(current, decision)),
    })}\n`;
  });
