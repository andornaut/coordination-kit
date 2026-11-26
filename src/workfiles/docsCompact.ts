import type { GitRunner } from "../core/git.ts";
import { parseDecisions } from "./decisions.ts";
import {
  exactRefs,
  headingSlug,
  isFile,
  links,
  localTarget,
  proseLines,
  readBlob,
  selection,
  sensitivePath,
  snapshot,
} from "./docsAudit.ts";
import { fieldIds, parseFrontMatter, STATUSES } from "./files.ts";

const WORK_ID = "[a-z][a-z0-9]*-[0-9]{4,}";
const WORK_PATH = new RegExp(`^docs/work/(${WORK_ID})\\.md$`);
const DESIGN_PATH = /^docs\/design\/([A-Za-z0-9_-]+)\.md$/;
const AREA = /^[A-Za-z0-9_-]+$/;
const MARKER = new RegExp(`^ {0,3}<!-- compact: superseded by (${WORK_ID}) -->[ \\t]*$`);
const TERMINAL = new Set(["cancelled", "declined", "done", "superseded"]);

interface Heading {
  readonly anchor: string;
  readonly label: string;
  readonly level: number;
  readonly line: number;
}

interface Reference {
  readonly anchor: string | null;
  readonly kind: "decision" | "link" | "work";
  readonly line: number;
  readonly path: string;
}

interface WorkRef {
  readonly approvalLine: number | null;
  readonly blob: string;
  readonly path: string;
  readonly status: string;
  readonly workId: string;
}

interface Evidence {
  readonly blob: string;
  readonly decisions: readonly {
    readonly id: string;
    readonly line: number;
    readonly supersedes: string | null;
  }[];
  readonly fromLine: number;
  readonly headings: readonly Heading[];
  readonly inboundLinks: readonly Reference[];
  readonly toLine: number;
}

export type DocsCompactionProposal = {
  readonly area: string | null;
  readonly evidence: Evidence;
  readonly path: string;
} & (
  | {
      readonly disposition: "needs-owner-runtime-review";
      readonly kind: "terminal-work";
      readonly status: string;
      readonly supersededBy: readonly WorkRef[];
      readonly supersedes: readonly string[];
      readonly workId: string;
    }
  | {
      readonly disposition: "unknown";
      readonly kind: "unknown-work";
      readonly reason: "metadata-unavailable" | "standalone-status-not-in-git";
      readonly workId: string;
    }
  | {
      readonly destination: string;
      readonly disposition: "propose-relocation";
      readonly kind: "relocate-index";
    }
  | {
      readonly disposition: "propose-compaction";
      readonly kind: "retired-prose";
      readonly successor: WorkRef;
    }
);

export interface DocsCompactionPlan {
  readonly area: string | null;
  readonly head: string;
  readonly proposals: readonly DocsCompactionProposal[];
  readonly schema: 1;
}

interface Document {
  readonly blob: string;
  readonly front: ReturnType<typeof parseFrontMatter>;
  readonly headings: readonly Heading[];
  readonly lines: readonly string[];
  readonly path: string;
  readonly raw: readonly string[];
}

interface Work {
  readonly approvalLine: number | null;
  readonly area: string | null;
  readonly document: Document;
  readonly status: string | null;
  readonly supersedes: readonly string[];
  readonly workId: string;
}

function headings(lines: readonly string[]): Heading[] {
  const result: Heading[] = [];
  const used = new Set<string>();
  lines.forEach((line, index) => {
    const atx = /^ {0,3}(#{1,6})[ \t]+(.+)$/.exec(line);
    const setext =
      line.trim() === "" || /^\s{4}|^\s*[|#<>-]/.test(line)
        ? null
        : /^ {0,3}(=+|-+)\s*$/.exec(lines[index + 1] ?? "");
    if (atx === null && setext === null) {
      return;
    }
    const label = (atx?.[2] ?? line).replace(/\s+#+\s*$/, "").trim();
    const slug = headingSlug(label);
    if (slug === "") {
      return;
    }
    let anchor = slug;
    for (let suffix = 1; used.has(anchor); suffix += 1) {
      anchor = `${slug}-${suffix}`;
    }
    used.add(anchor);
    result.push({
      anchor,
      label,
      level: atx?.[1]?.length ?? (setext?.[1]?.startsWith("=") === true ? 1 : 2),
      line: index + 1,
    });
  });
  return result;
}

function document(path: string, blob: string, text: string): Document {
  const content = text.replace(/\r\n/g, "\n");
  const raw = content.split("\n");
  if (raw.at(-1) === "") {
    raw.pop();
  }
  const front = parseFrontMatter(content);
  const frontEnd = front === null ? -1 : raw.indexOf("---", 1);
  const lines = proseLines(content).slice(0, raw.length);
  for (let index = 0; index <= frontEnd; index += 1) {
    lines[index] = "";
  }
  return { blob, front, headings: headings(lines), lines, path, raw };
}

function workFile(doc: Document): Work | null {
  const workId = WORK_PATH.exec(doc.path)?.[1];
  if (workId === undefined) {
    return null;
  }
  const fields = doc.front?.fields;
  const design = fields?.design;
  const status = STATUSES.find((candidate) => candidate === fields?.status);
  const area = typeof design === "string" && AREA.test(design) ? design : null;
  return {
    approvalLine:
      typeof fields?.approved === "string" && fields.approved.trim() !== ""
        ? doc.raw.findIndex((line) => line.startsWith("approved:")) + 1
        : null,
    area,
    document: doc,
    status:
      doc.front?.problems.length === 0 && fields?.id === workId && area !== null
        ? (status ?? null)
        : null,
    supersedes: fieldIds(fields?.supersedes),
    workId,
  };
}

function workRef(work: Work, status: string): WorkRef {
  return {
    approvalLine: work.approvalLine,
    blob: work.document.blob,
    path: work.document.path,
    status,
    workId: work.workId,
  };
}

/** Recognize canonical blob links to this repository without reading its remote configuration. */
function githubBlobPrefix(content: string): string | null {
  try {
    const value = (JSON.parse(content) as { repository?: unknown }).repository;
    const url = typeof value === "object" && value !== null && "url" in value ? value.url : value;
    if (typeof url !== "string") {
      return null;
    }
    const match =
      /^(?:git\+)?https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url) ??
      /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url);
    return match?.[1] === undefined ? null : `https://github.com/${match[1]}/blob/main/`;
  } catch {
    return null;
  }
}

function resolveLink(from: string, target: string, blobPrefix: string | null) {
  if (blobPrefix !== null && target.startsWith(blobPrefix)) {
    return localTarget(from, `/${target.slice(blobPrefix.length)}`);
  }
  return /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(target) ? null : localTarget(from, target);
}

function inbound(
  docs: ReadonlyMap<string, Document>,
  blobPrefix: string | null,
): ReadonlyMap<string, readonly Reference[]> {
  const result = new Map<string, Reference[]>();
  function add(target: string, entry: Reference): void {
    if (!docs.has(target)) {
      return;
    }
    const entries = result.get(target) ?? [];
    entries.push(entry);
    result.set(target, entries);
  }
  for (const { front, lines, path, raw } of docs.values()) {
    lines.forEach((text, index) => {
      const line = index + 1;
      for (const link of links(text, line)) {
        const target = resolveLink(path, link.target, blobPrefix);
        if (target !== null) {
          add(target.path, { anchor: target.anchor || null, kind: "link", line, path });
        }
      }
      for (const { decision, id } of exactRefs(text, line)) {
        add(`docs/work/${id}.md`, {
          anchor: decision ?? null,
          kind: decision === undefined ? "work" : "decision",
          line,
          path,
        });
      }
    });
    for (const key of ["related", "supersedes"]) {
      for (const id of fieldIds(front?.fields[key])) {
        const line = raw.findIndex((text) => text.startsWith(`${key}:`)) + 1;
        add(`docs/work/${id}.md`, { anchor: null, kind: "work", line, path });
      }
    }
    for (const { line, supersedes } of parseDecisions(lines.join("\n")).decisions) {
      const [id, decision] = supersedes?.split("/") ?? [];
      if (decision !== undefined) {
        add(`docs/work/${id}.md`, { anchor: decision, kind: "decision", line, path });
      }
    }
  }
  return result;
}

function evidence(
  doc: Document,
  references: ReadonlyMap<string, readonly Reference[]>,
  fromLine = 1,
  toLine = doc.raw.length,
  leadingHeading?: Heading,
): Evidence {
  const recorded = doc.headings.filter(({ line }) => line >= fromLine && line <= toLine);
  if (leadingHeading !== undefined) {
    recorded.unshift(leadingHeading);
  }
  return {
    blob: doc.blob,
    decisions: parseDecisions(doc.lines.join("\n"))
      .decisions.filter(({ line }) => line >= fromLine && line <= toLine)
      .map(({ id, line, supersedes }) => ({ id, line, supersedes })),
    fromLine,
    headings: recorded,
    inboundLinks: references.get(doc.path) ?? [],
    toLine,
  };
}

function tableCells(line: string): string[] {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|")
    ? trimmed
        .slice(1, -1)
        .split("|")
        .map((part) => part.trim())
    : [];
}

function indexes(doc: Document, blobPrefix: string | null) {
  const tables: { from: number; to: number; rows: string[] }[] = [];
  for (let index = 0; index < doc.lines.length; index += 1) {
    if (tableCells(doc.lines[index] ?? "").join("|") !== "ID|Title|Link") {
      continue;
    }
    const separator = tableCells(doc.lines[index + 1] ?? "");
    if (separator.length !== 3 || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      continue;
    }
    const rows: string[] = [];
    let end = index + 2;
    for (; end < doc.lines.length; end += 1) {
      const cells = tableCells(doc.lines[end] ?? "");
      if (cells.length !== 3 || cells.join("|") === "ID|Title|Link") {
        break;
      }
      const [, , link = ""] = cells;
      const target = links(link, end + 1)[0]?.target ?? link;
      const resolved = resolveLink(doc.path, target, blobPrefix);
      rows.push(JSON.stringify([cells[0], cells[1], resolved ?? target]));
    }
    if (rows.length > 0) {
      tables.push({ from: index + 1, rows: rows.sort(), to: end });
    }
    index = end - 1;
  }
  return tables;
}

function retired(
  doc: Document,
  works: ReadonlyMap<string, Work>,
  references: ReadonlyMap<string, readonly Reference[]>,
): DocsCompactionProposal[] {
  const visible = proseLines(
    doc.raw.map((line) => (MARKER.test(line) ? "compaction marker" : line)).join("\n"),
  );
  const result: DocsCompactionProposal[] = [];
  doc.raw.forEach((line, index) => {
    const id = MARKER.exec(line)?.[1];
    if (id === undefined || visible[index] !== "compaction marker") {
      return;
    }
    const successor = works.get(id);
    if (successor?.status !== "done" || successor.approvalLine === null) {
      return;
    }
    let next = index + 1;
    while ((doc.raw[next] ?? "").trim() === "" && next < doc.raw.length) {
      next += 1;
    }
    const at = doc.headings.findIndex((heading) => heading.line === next + 1);
    const heading = doc.headings[at];
    if (heading === undefined) {
      return;
    }
    const boundary = doc.headings.slice(at + 1).find((later) => later.level <= heading.level);
    let end = (boundary?.line ?? doc.raw.length + 1) - 1;
    if (boundary !== undefined) {
      let before = end - 1;
      while (before > next && (doc.raw[before] ?? "").trim() === "") {
        before -= 1;
      }
      if (MARKER.test(doc.raw[before] ?? "") && visible[before] === "compaction marker") {
        end = before;
      }
    }
    result.push({
      area: DESIGN_PATH.exec(doc.path)?.[1] ?? null,
      disposition: "propose-compaction",
      evidence: evidence(doc, references, index + 1, end),
      kind: "retired-prose",
      path: doc.path,
      successor: workRef(successor, "done"),
    });
  });
  return result;
}

/** Plan from committed Markdown only. Every proposal still requires separate human authority. */
export function planDocsCompaction(
  git: GitRunner,
  root: string,
  area?: string,
): DocsCompactionPlan {
  const select = selection(area);
  const { entries, head } = snapshot(git, root);
  const packageFile = entries.get("package.json");
  const blobPrefix =
    packageFile !== undefined && isFile(packageFile)
      ? githubBlobPrefix(readBlob(git, root, packageFile))
      : null;
  const docs = new Map<string, Document>();
  const works = new Map<string, Work>();
  for (const [path, entry] of entries) {
    if (!/\.md$/i.test(path) || sensitivePath(path) || !isFile(entry)) {
      continue;
    }
    const doc = document(path, entry.oid, readBlob(git, root, entry));
    docs.set(path, doc);
    const work = workFile(doc);
    if (work !== null) {
      works.set(work.workId, work);
    }
  }
  const selectedWork = (work: Work) =>
    select(work.document.path) ||
    (work.area !== null &&
      (select(`docs/design/${work.area}.md`) || select(`docs/${work.area}.md`)));
  if (
    area !== undefined &&
    ![...docs.keys()].some(select) &&
    ![...works.values()].some(selectedWork)
  ) {
    throw new Error("docs compaction area has no tracked Markdown at HEAD");
  }
  const refs = inbound(docs, blobPrefix);
  const proposals: DocsCompactionProposal[] = [];
  for (const work of works.values()) {
    if (!selectedWork(work)) {
      continue;
    }
    const { document: doc, status, supersedes, workId } = work;
    if (status !== null && !TERMINAL.has(status)) {
      continue;
    }
    const basis = { area: work.area, evidence: evidence(doc, refs), path: doc.path, workId };
    if (status === null) {
      proposals.push({
        ...basis,
        disposition: "unknown",
        kind: "unknown-work",
        reason:
          doc.front === null && doc.lines.includes("## Approved scope")
            ? "standalone-status-not-in-git"
            : "metadata-unavailable",
      });
      continue;
    }
    const supersededBy = [...works.values()].flatMap((other) =>
      other.workId !== workId && other.status !== null && other.supersedes.includes(workId)
        ? [workRef(other, other.status)]
        : [],
    );
    proposals.push({
      ...basis,
      disposition: "needs-owner-runtime-review",
      kind: "terminal-work",
      status,
      supersededBy,
      supersedes,
    });
  }
  for (const doc of docs.values()) {
    if (!select(doc.path) || doc.path.startsWith("docs/work/")) {
      continue;
    }
    const designArea = DESIGN_PATH.exec(doc.path)?.[1];
    if (designArea !== undefined) {
      const destination = `docs/work/index/${designArea}.md`;
      const existing = docs.get(destination);
      if (existing === undefined && entries.has(destination)) {
        continue;
      }
      const newTables = existing === undefined ? [] : indexes(existing, blobPrefix);
      for (const { from, rows, to } of indexes(doc, blobPrefix)) {
        if (newTables.some((table) => rows.every((row) => table.rows.includes(row)))) {
          continue;
        }
        proposals.push({
          area: designArea,
          destination,
          disposition: "propose-relocation",
          evidence: evidence(
            doc,
            refs,
            from,
            to,
            doc.headings.findLast(({ line }) => line < from),
          ),
          kind: "relocate-index",
          path: doc.path,
        });
      }
    }
    proposals.push(...retired(doc, works, refs));
  }
  proposals.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.evidence.fromLine - right.evidence.fromLine ||
      left.kind.localeCompare(right.kind),
  );
  return { area: area ?? null, head, proposals, schema: 1 };
}
