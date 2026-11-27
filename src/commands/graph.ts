// Decision graph queries over the coordinator's registered repositories and the
// store. Each prints one JSON object (or DOT for `graph --format dot`); a refusal prints
// `coordination-kit: CODE` and exits 1, a usage error exits 2.
import type { Handler } from "../core/cli/io.ts";
import { type GitRunner, systemGit } from "../core/git.ts";
import { Store } from "../store/db.ts";
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
import { Usage, verbFamily } from "./args.ts";

export const GRAPH_OPTIONS = {
  depth: { type: "string" },
  format: { type: "string" },
  work: { type: "string" },
} as const;
export const GRAPH_WHY_OPTIONS = { decision: { type: "string" } } as const;

function load(
  context: { readonly env: NodeJS.ProcessEnv; readonly git: GitRunner },
  coordinator: Coordinator,
): Graph {
  const { git } = context;
  const store = Store.readLayout(context, coordinator.layout);
  try {
    return buildGraph(git, coordinator, store);
  } finally {
    store?.close();
  }
}

/** The graph verbs' wrapper: Git over the real environment and the coordinator `--root` names. */
const graphVerb = verbFamily("graph", (io, root) => ({
  env: io.env,
  git: systemGit(io.env),
  root,
}));

export const graph: Handler = graphVerb("graph", GRAPH_OPTIONS, (context, values) => {
  const format = (values.format as string | undefined) ?? "json";
  const depthText = values.depth as string | undefined;
  if (
    !["json", "dot"].includes(format) ||
    (depthText !== undefined && !/^(?:[0-9]|[1-9][0-9])$/.test(depthText))
  ) {
    throw new Usage();
  }
  const current = load(context, openCoordinator(context.git, context.root));
  const work = values.work as string | undefined;
  const selected =
    work === undefined
      ? current
      : neighbourhood(current, findWork(current, work), Number(depthText ?? 2));
  if (format === "dot") {
    return graphDot(selected);
  }
  return {
    kind: "graph",
    schema: 2,
    unavailable: current.unavailable,
    ...graphJson(selected),
  };
});

export const graphWhy: Handler = graphVerb("graph why", GRAPH_WHY_OPTIONS, (context, values) => {
  const decision = values.decision as string | undefined;
  if (decision === undefined) {
    throw new Usage();
  }
  const current = load(context, openCoordinator(context.git, context.root));
  return {
    kind: "graph-why",
    schema: 2,
    unavailable: current.unavailable,
    ...why(current, findDecision(current, decision)),
  };
});
