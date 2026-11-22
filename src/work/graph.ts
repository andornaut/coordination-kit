// The decision graph: work items, decisions, questions, roles and commits, joined by typed edges.
// Git is the durable copy (work files on each registered repository's `main`, with their front
// matter and Decisions lines); the store adds work records (parent links, stage commits) and its
// decision and question records.
import type { DatabaseSync } from "node:sqlite";

import type { Repository } from "../status/collect.ts";
import { type GitRunner, readMainFiles } from "../status/git.ts";
import type { Store } from "../store/db.ts";
import { listQuestions } from "../store/questions.ts";
import { StoreError } from "../store/types.ts";
import { readWorkRecords } from "../store/work.ts";
import { parseDecisions } from "./decisions.ts";
import { CONVENTION_FILE, fieldIds, type FrontMatterValue, parseFrontMatter } from "./files.ts";
import { type Coordinator, storeDecisions, workOwner } from "./live.ts";

export const EDGE_KINDS = [
  "decides",
  "answers",
  "owned-by",
  "supersedes",
  "related",
  "implements",
  "parent",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
export type NodeType = "work" | "decision" | "question" | "role" | "commit";

export interface GraphNode {
  /** `TYPE:ID`, such as `work:coordination-kit:ck-0018` or `decision:coordination-kit:ck-0018/D1`. */
  readonly key: string;
  readonly type: NodeType;
  readonly id: string;
  readonly attrs: Readonly<Record<string, string | null>>;
}

export interface GraphEdge {
  readonly kind: EdgeKind;
  readonly from: string;
  readonly to: string;
  readonly source: "git" | "store";
  /** The stage of an `implements` edge, else null. */
  readonly detail: string | null;
}

export interface Graph {
  readonly nodes: ReadonlyMap<string, GraphNode>;
  readonly edges: readonly GraphEdge[];
  /** Registered repositories whose work files could not be read. */
  readonly unavailable: readonly string[];
}

const WORK_DIRECTORY = "docs/work";

export function workKey(repository: string, id: string): string {
  return `work:${repository}:${id}`;
}

export function decisionKey(repository: string, work: string, decision: string): string {
  return `decision:${repository}:${work}/${decision}`;
}

class Builder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  /** Work ID to the repositories holding it, for links that name a bare ID. */
  readonly workIds = new Map<string, string[]>();

  node(type: NodeType, id: string, attrs: Record<string, string | null> = {}): string {
    const key = `${type}:${id}`;
    const existing = this.nodes.get(key);
    this.nodes.set(key, { attrs: { ...existing?.attrs, ...attrs }, id, key, type });
    return key;
  }

  edge(
    kind: EdgeKind,
    from: string,
    to: string,
    source: GraphEdge["source"],
    detail: string | null = null,
  ): void {
    const id = `${kind}\n${from}\n${to}\n${detail ?? ""}`;
    if (!this.edges.has(id)) {
      this.edges.set(id, { detail, from, kind, source, to });
    }
  }

  /** A bare work ID in `repository` first, else the one repository that holds it. */
  resolveWork(id: string, repository: string): string | null {
    const holders = this.workIds.get(id) ?? [];
    if (holders.includes(repository)) {
      return workKey(repository, id);
    }
    return holders.length === 1 ? workKey(holders[0]!, id) : null;
  }
}

function value(fields: Readonly<Record<string, FrontMatterValue>>, key: string): string | null {
  const item = fields[key];
  return typeof item === "string" && item !== "" ? item : null;
}

interface ParsedFile {
  readonly repository: Repository;
  readonly id: string;
  readonly fields: Readonly<Record<string, FrontMatterValue>>;
  readonly text: string;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/** The store's questions through `listQuestions`: id and owning role. */
function storeQuestions(store: Pick<Store, "db">): { id: string; owner: string | null }[] {
  return listQuestions(store).map((question) => ({ id: question.id, owner: question.role }));
}

/** Build the graph from every registered repository's `main` and, when given, the store. */
export function buildGraph(
  git: GitRunner,
  coordinator: Coordinator,
  store: Pick<Store, "db"> | null,
): Graph {
  const builder = new Builder();
  const unavailable: string[] = [];
  const files: ParsedFile[] = [];
  for (const repository of coordinator.repositories) {
    if (repository.reason !== null) {
      unavailable.push(repository.name);
      continue;
    }
    let read;
    try {
      read = readMainFiles(git, repository.path, WORK_DIRECTORY);
    } catch {
      unavailable.push(repository.name);
      continue;
    }
    for (const file of read.files.values()) {
      const name = file.path.slice(WORK_DIRECTORY.length + 1);
      if (name.includes("/") || !name.endsWith(".md") || name === CONVENTION_FILE) {
        continue;
      }
      const fields = parseFrontMatter(file.text)?.fields ?? {};
      const id = value(fields, "id") ?? name.slice(0, -3);
      files.push({ fields, id, repository, text: file.text });
      builder.workIds.set(id, [...(builder.workIds.get(id) ?? []), repository.name]);
    }
  }
  for (const file of files) {
    const repository = file.repository.name;
    const work = builder.node("work", `${repository}:${file.id}`, {
      approved: value(file.fields, "approved"),
      design: value(file.fields, "design"),
      repository,
      status: value(file.fields, "status"),
      title: value(file.fields, "title"),
      work: file.id,
    });
    const owner = workOwner(file.repository, file.fields);
    if (owner !== null) {
      builder.edge("owned-by", work, builder.node("role", owner), "git");
    }
    for (const id of fieldIds(file.fields.supersedes)) {
      const replaced = builder.resolveWork(id, repository);
      if (replaced !== null) {
        builder.edge("supersedes", work, replaced, "git");
      }
    }
    const related = file.fields.related;
    for (const id of Array.isArray(related) ? related : []) {
      const target = builder.resolveWork(id, repository);
      if (target !== null) {
        builder.edge("related", work, target, "git");
      }
    }
    for (const decision of parseDecisions(file.text).decisions) {
      const key = builder.node("decision", `${repository}:${file.id}/${decision.id}`, {
        answers: decision.answers,
        at: decision.at,
        by: decision.by,
        repository,
        supersedes: decision.supersedes,
        text: decision.text,
        work: file.id,
      });
      builder.edge("decides", key, work, "git");
      if (decision.answers !== null) {
        builder.edge("answers", key, builder.node("question", decision.answers), "git");
      }
      if (decision.supersedes !== null) {
        const target = decisionTarget(builder, repository, file.id, decision.supersedes);
        if (target !== null) {
          builder.edge("supersedes", key, target, "git");
        }
      }
    }
  }
  if (store !== null) {
    addStore(builder, store);
  }
  return {
    edges: [...builder.edges.values()],
    nodes: builder.nodes,
    unavailable,
  };
}

/** `D1` within the same item, or `ck-0006/D1` in the repository that holds `ck-0006`. */
function decisionTarget(
  builder: Builder,
  repository: string,
  work: string,
  target: string,
): string | null {
  if (!target.includes("/")) {
    return builder.node("decision", `${repository}:${work}/${target}`);
  }
  const [otherWork = "", decision = ""] = target.split("/");
  const resolved = builder.resolveWork(otherWork, repository);
  if (resolved === null) {
    return null;
  }
  const otherRepository = resolved.slice("work:".length, resolved.lastIndexOf(":"));
  return builder.node("decision", `${otherRepository}:${otherWork}/${decision}`);
}

function addStore(builder: Builder, store: Pick<Store, "db">): void {
  if (tableExists(store.db, "work")) {
    for (const record of readWorkRecords(store.db).values()) {
      const work = builder.node("work", `${record.repository}:${record.id}`, {
        repository: record.repository,
        state: record.state,
        work: record.id,
      });
      if (record.owner !== null) {
        builder.edge("owned-by", work, builder.node("role", record.owner), "store");
      }
      if (record.parent !== null) {
        const parent = builder.node("work", `${record.parent.repository}:${record.parent.id}`, {
          repository: record.parent.repository,
          work: record.parent.id,
        });
        builder.edge("parent", work, parent, "store");
      }
      for (const evidence of record.evidence) {
        builder.edge(
          "implements",
          builder.node("commit", evidence.sha),
          work,
          "store",
          evidence.stage,
        );
      }
    }
  }
  for (const decision of storeDecisions(store)) {
    const work =
      decision.repository === null
        ? builder.resolveWork(decision.work, "")
        : workKey(decision.repository, decision.work);
    if (work === null) {
      continue;
    }
    const repository = work.slice("work:".length, work.lastIndexOf(":"));
    const key = builder.node("decision", `${repository}:${decision.work}/${decision.id}`);
    const node = builder.nodes.get(key)!;
    // Git is the durable copy: store fields fill only what the work file does not say.
    builder.nodes.set(key, {
      ...node,
      attrs: {
        answers: decision.question,
        at: decision.at,
        by: decision.by,
        repository,
        role: decision.role,
        supersedes: decision.supersedes,
        text: decision.text,
        work: decision.work,
        ...Object.fromEntries(Object.entries(node.attrs).filter(([, item]) => item !== null)),
      },
    });
    builder.edge("decides", key, work, "store");
    if (decision.question !== null) {
      builder.edge("answers", key, builder.node("question", decision.question), "store");
    }
    if (decision.supersedes !== null) {
      const target = decisionTarget(builder, repository, decision.work, decision.supersedes);
      if (target !== null) {
        builder.edge("supersedes", key, target, "store");
      }
    }
  }
  for (const question of storeQuestions(store)) {
    const key = builder.node("question", question.id);
    if (question.owner !== null) {
      builder.edge("owned-by", key, builder.node("role", question.owner), "store");
    }
  }
}

function sortedEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  return [...edges].sort(
    (left, right) =>
      left.from.localeCompare(right.from, "en") ||
      left.kind.localeCompare(right.kind, "en") ||
      left.to.localeCompare(right.to, "en"),
  );
}

/** A work item by `repository:id` or a bare ID that one repository holds. */
export function findWork(graph: Graph, id: string): string {
  const direct = `work:${id}`;
  if (id.includes(":")) {
    if (!graph.nodes.has(direct)) {
      throw new StoreError("work-unknown");
    }
    return direct;
  }
  const matches = [...graph.nodes.values()].filter(
    (node) => node.type === "work" && node.attrs.work === id,
  );
  if (matches.length === 0) {
    throw new StoreError("work-unknown");
  }
  if (matches.length > 1) {
    throw new StoreError("work-ambiguous");
  }
  return matches[0]!.key;
}

/** The nodes within `depth` edges of `start`, in either direction, and the edges among them. */
export function neighbourhood(graph: Graph, start: string, depth: number): Graph {
  const seen = new Set([start]);
  let frontier = [start];
  for (let step = 0; step < depth && frontier.length > 0; step += 1) {
    const next: string[] = [];
    for (const edge of graph.edges) {
      for (const [from, to] of [
        [edge.from, edge.to],
        [edge.to, edge.from],
      ] as const) {
        if (frontier.includes(from) && !seen.has(to)) {
          seen.add(to);
          next.push(to);
        }
      }
    }
    frontier = next;
  }
  return {
    ...graph,
    edges: graph.edges.filter((edge) => seen.has(edge.from) && seen.has(edge.to)),
    nodes: new Map([...graph.nodes].filter(([key]) => seen.has(key))),
  };
}

export interface GraphJson {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export function graphJson(graph: Graph): GraphJson {
  return {
    edges: sortedEdges(graph.edges),
    nodes: [...graph.nodes.values()].sort((left, right) => left.key.localeCompare(right.key, "en")),
  };
}

function quote(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Graphviz DOT: one node per key, labelled with its ID and title, one edge per relation. */
export function graphDot(graph: Graph): string {
  const json = graphJson(graph);
  const lines = ["digraph coordination {", "  rankdir=LR;"];
  for (const node of json.nodes) {
    const title = node.attrs.title ?? null;
    const label = title === null ? `${node.type} ${node.id}` : `${node.id}\\n${title}`;
    lines.push(`  ${quote(node.key)} [label=${quote(label)}, shape=${shape(node.type)}];`);
  }
  for (const edge of json.edges) {
    const label = edge.detail === null ? edge.kind : `${edge.kind} (${edge.detail})`;
    lines.push(`  ${quote(edge.from)} -> ${quote(edge.to)} [label=${quote(label)}];`);
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function shape(type: NodeType): string {
  return { commit: "note", decision: "diamond", question: "ellipse", role: "house", work: "box" }[
    type
  ];
}

export interface WhyStep {
  readonly key: string;
  readonly decision: string;
  readonly by: string | null;
  readonly at: string | null;
  readonly text: string | null;
  readonly answers: string | null;
  readonly work: string | null;
  /** The approval reference of the work item the decision belongs to. */
  readonly approved: string | null;
}

export interface WhyResult {
  readonly decision: WhyStep;
  /** Older decisions this one replaces, nearest first. */
  readonly supersedes: readonly WhyStep[];
  /** Newer decisions that replace this one, nearest first. */
  readonly supersededBy: readonly WhyStep[];
  /** The newest decision of the chain: the one in force. */
  readonly current: string;
}

/** A decision by `repository:work/Dn` or `work/Dn` with a work ID one repository holds. */
export function findDecision(graph: Graph, id: string): string {
  if (id.includes(":")) {
    const key = `decision:${id}`;
    if (!graph.nodes.has(key)) {
      throw new StoreError("decision-unknown");
    }
    return key;
  }
  const matches = [...graph.nodes.keys()].filter(
    (key) => key.startsWith("decision:") && key.endsWith(`:${id}`),
  );
  if (matches.length === 0) {
    throw new StoreError("decision-unknown");
  }
  if (matches.length > 1) {
    throw new StoreError("decision-ambiguous");
  }
  return matches[0]!;
}

/** The supersedes chain of one decision in both directions, with each item's approval. */
export function why(graph: Graph, key: string): WhyResult {
  const step = (node: string): WhyStep => {
    const attrs = graph.nodes.get(node)?.attrs ?? {};
    const work = graph.edges.find((edge) => edge.kind === "decides" && edge.from === node)?.to;
    return {
      answers: attrs.answers ?? null,
      approved: work === undefined ? null : (graph.nodes.get(work)?.attrs.approved ?? null),
      at: attrs.at ?? null,
      by: attrs.by ?? null,
      decision: node.slice("decision:".length),
      key: node,
      text: attrs.text ?? null,
      work: attrs.work ?? null,
    };
  };
  const walk = (from: string, forward: boolean): string[] => {
    const chain: string[] = [];
    const seen = new Set([from]);
    let current: string | undefined = from;
    while (current !== undefined) {
      const at: string = current;
      const next = graph.edges.find(
        (edge) =>
          edge.kind === "supersedes" &&
          (forward ? edge.to === at : edge.from === at) &&
          (forward ? edge.from : edge.to).startsWith("decision:"),
      );
      current = next === undefined ? undefined : forward ? next.from : next.to;
      if (current !== undefined) {
        if (seen.has(current)) {
          break;
        }
        seen.add(current);
        chain.push(current);
      }
    }
    return chain;
  };
  const older = walk(key, false);
  const newer = walk(key, true);
  return {
    current: (newer.at(-1) ?? key).slice("decision:".length),
    decision: step(key),
    supersededBy: newer.map(step),
    supersedes: older.map(step),
  };
}
