import { realpathSync } from "node:fs";
import { posix } from "node:path";

import type { GitRunner } from "../core/git.ts";
import { parseDecisions } from "./decisions.ts";
import { parseFrontMatter } from "./files.ts";

type FindingCode = "broken-anchor" | "broken-link" | "broken-work-ref" | "duplicate-rule";
type EvidenceKind = "decision" | "external" | "local" | "work";

interface AuditFinding {
  readonly code: FindingCode;
  readonly line: number;
  readonly message: string;
  readonly path: string;
}

interface Evidence {
  readonly kind: EvidenceKind;
  readonly line: number;
  readonly target: string;
}

interface Rule {
  readonly behavior: "unverified";
  readonly evidence: readonly Evidence[];
  readonly id: string;
  readonly line: number;
  readonly path: string;
}

export interface DocsAudit {
  readonly area: string | null;
  readonly files: readonly string[];
  readonly findings: readonly AuditFinding[];
  readonly head: string;
  readonly ok: boolean;
  readonly rules: readonly Rule[];
}

interface Entry {
  readonly mode: string;
  readonly oid: string;
}

interface Link {
  readonly line: number;
  readonly target: string;
}

interface ExactRef {
  readonly decision: string | undefined;
  readonly id: string;
  readonly line: number;
}

interface Document {
  readonly anchors: Set<string>;
  readonly links: readonly Link[];
  readonly refs: readonly ExactRef[];
  readonly rules: readonly Rule[];
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MARKDOWN = /\.md$/i;
const SCHEME = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/;
const RULE_ID = /^rule-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORK_ID = "[a-z][a-z0-9]*-[0-9]{4,}";
const DECISION = "D[1-9][0-9]*";
const WORK_PATH = new RegExp(`^docs/work/(${WORK_ID})\\.md$`);
const WORK_REF = new RegExp(`(?<!\`)\`(${WORK_ID})(?:/(${DECISION}))?\`(?!\`)`, "g");

export function sensitivePath(path: string): boolean {
  return path
    .split("/")
    .some((part) =>
      /^(?:\.env(?:[.-]|$)|\.git$|\.ssh$|\.gnupg$|\.?(?:credentials?|private|secrets?|vaults?)(?:\.|$))/i.test(
        part,
      ),
    );
}

export function isFile(entry: Entry | undefined): boolean {
  return entry !== undefined && /^100[0-7]{3}$/.test(entry.mode);
}

/** Enumerate the commit tree; symlinks and submodules are never opened. */
export function snapshot(
  git: GitRunner,
  root: string,
): { entries: Map<string, Entry>; head: string } {
  const run = (...args: string[]) => git(root, ["--no-replace-objects", ...args]);
  if (run("rev-parse", "--show-toplevel").replace(/\r?\n$/, "") !== realpathSync(root)) {
    throw new Error("docs audit requires the Git checkout root");
  }
  if (
    run("config", "--null", "--name-only", "--list")
      .split("\0")
      .some((key) => /^(?:extensions\.partialclone|remote\..+\.promisor)$/i.test(key))
  ) {
    throw new Error("docs audit requires a full local Git checkout");
  }
  const head = run("rev-parse", "--verify", "HEAD^{commit}").trim();
  if (!OID.test(head)) {
    throw new Error("docs audit could not resolve a local HEAD commit");
  }
  if (
    run(
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
      "--ignore-submodules=all",
    ) !== ""
  ) {
    throw new Error("docs audit requires tracked files clean at HEAD");
  }
  const entries = new Map<string, Entry>();
  for (const row of run("ls-tree", "-rtz", "--full-tree", head).split("\0")) {
    if (row === "") {
      continue;
    }
    const [, mode = "", oid = "", path = ""] =
      /^(\d{6}) \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(row) ?? [];
    if (!OID.test(oid)) {
      throw new Error("invalid docs audit Git tree");
    }
    entries.set(path, { mode, oid });
  }
  return { entries, head };
}

export function selection(area: string | undefined): (path: string) => boolean {
  if (area === undefined) {
    return () => true;
  }
  if (!/^(?:docs\/(?:[A-Za-z0-9_-]+\/)*|)[A-Za-z0-9_-]+$/.test(area)) {
    throw new Error("docs audit area must be a name or a path under docs without .md");
  }
  const prefixes = area.includes("/") ? [area] : [`docs/${area}`, `docs/design/${area}`];
  return (path) =>
    prefixes.some((prefix) => path === `${prefix}.md` || path.startsWith(`${prefix}/`));
}

export function proseLines(text: string): string[] {
  let fence = "";
  return text
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\r\n]/g, " "))
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker !== null) {
        const [, run = "", rest = ""] = marker;
        if (fence === "" && !(run.startsWith("`") && rest.includes("`"))) {
          fence = run;
          return "";
        }
        if (run.startsWith(fence) && rest.trim() === "") {
          fence = "";
          return "";
        }
      }
      return fence === "" ? line : "";
    });
}

export function headingSlug(label: string): string {
  return label
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, "")
    .replace(/\s/g, "-");
}

const LINK_DESTINATION =
  /\]\(\s*(?:<([^<>]*)>|((?:[^\s()\\]|\\.|\([^\s()]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REFERENCE_DESTINATION = /^ {0,3}\[[^\]]+\]:\s*(?:<([^<>]+)>|([^\s]+))/;
const EXPLICIT_ANCHOR = /<[a-z][\w-]*\b[^<>]*?\s(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
const EVIDENCE_LINE =
  /^ {0,3}(?:[-*+]\s+)?(?:Evidence:|\*\*Evidence:\*\*|\*\*Evidence\*\*:)[ \t]*(.*)$/i;

export function links(line: string, number: number): Link[] {
  const plain = line.replace(/(`+).*?\1/g, "");
  const definition = REFERENCE_DESTINATION.exec(plain);
  const matches = definition === null ? [...plain.matchAll(LINK_DESTINATION)] : [definition];
  return matches.map((match) => ({
    line: number,
    target: (match[1] ?? match[2] ?? "").replace(/\\([\\()<>])/g, "$1"),
  }));
}

export function exactRefs(line: string, number: number): ExactRef[] {
  return [...line.matchAll(WORK_REF)].map((match) => ({
    decision: match[2],
    id: match[1]!,
    line: number,
  }));
}

function safeEvidenceTarget(target: string, from: string): string | null {
  if (SCHEME.test(target)) {
    try {
      const url = new URL(target, "https://example.invalid");
      if (
        url.username !== "" ||
        url.password !== "" ||
        !["http:", "https:"].includes(url.protocol)
      ) {
        return null;
      }
      url.search = "";
      return url.href;
    } catch {
      return null;
    }
  }
  const resolved = localTarget(from, target);
  return resolved === null || sensitivePath(resolved.path) ? null : target.replace(/\?[^#]*/, "");
}

export function localTarget(from: string, target: string): { anchor: string; path: string } | null {
  const hash = target.indexOf("#");
  const location = (hash < 0 ? target : target.slice(0, hash)).split("?")[0] ?? "";
  try {
    const decoded = decodeURIComponent(location);
    if (decoded.includes("\\") || [...decoded].some((character) => character < " ")) {
      return null;
    }
    const path =
      decoded === ""
        ? from
        : posix
            .normalize(
              decoded.startsWith("/") ? decoded.slice(1) : posix.join(posix.dirname(from), decoded),
            )
            .replace(/\/$/, "");
    if (path === ".." || path.startsWith("../") || path.startsWith("/")) {
      return null;
    }
    return {
      anchor: hash < 0 ? "" : decodeURIComponent(target.slice(hash + 1)),
      path: path === "" ? "." : path,
    };
  } catch {
    return null;
  }
}

function readDocument(path: string, text: string): Document {
  const anchors = new Set<string>();
  const usedSlugs = new Set<string>();
  const foundLinks: Link[] = [];
  const refs: ExactRef[] = [];
  const rules: Rule[] = [];
  const lines = proseLines(text);
  let active: { evidence: Evidence[]; headingLevel: number | undefined } | undefined;
  lines.forEach((line, index) => {
    const number = index + 1;
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(line);
    const setext =
      line.trim() !== "" && !/^\s*[#<>]|^\s{4}/.test(line)
        ? /^ {0,3}(=+|-+)\s*$/.exec(lines[index + 1] ?? "")
        : null;
    if (heading !== null || setext !== null) {
      const level = heading?.[1]?.length ?? (setext?.[1]?.startsWith("=") ? 1 : 2);
      if (active !== undefined) {
        if (active.headingLevel === undefined) {
          active.headingLevel = level;
        } else if (level <= active.headingLevel) {
          active = undefined;
        }
      }
      const slug = headingSlug((heading?.[2] ?? line).replace(/\s+#+\s*$/, ""));
      if (slug !== "") {
        let unique = slug;
        for (let suffix = 1; usedSlugs.has(unique); suffix += 1) {
          unique = `${slug}-${suffix}`;
        }
        usedSlugs.add(unique);
        anchors.add(unique);
      }
    }
    const plain = line.replace(/(`+).*?\1/g, "");
    for (const match of plain.matchAll(EXPLICIT_ANCHOR)) {
      const anchor = match[1] ?? match[2] ?? "";
      anchors.add(anchor);
      if (RULE_ID.test(anchor)) {
        const evidence: Evidence[] = [];
        rules.push({ behavior: "unverified", evidence, id: anchor, line: number, path });
        active = { evidence, headingLevel: heading?.[1]?.length };
      }
    }
    foundLinks.push(...links(line, number));
    const evidence = EVIDENCE_LINE.exec(line)?.[1];
    if (active !== undefined && evidence !== undefined) {
      for (const link of links(evidence, number)) {
        const target = safeEvidenceTarget(link.target, path);
        if (target !== null) {
          active.evidence.push({
            kind: SCHEME.test(link.target) ? "external" : "local",
            line: number,
            target,
          });
        }
      }
      for (const ref of exactRefs(evidence, number)) {
        refs.push(ref);
        active.evidence.push({
          kind: ref.decision === undefined ? "work" : "decision",
          line: number,
          target: ref.decision === undefined ? ref.id : `${ref.id}/${ref.decision}`,
        });
      }
    }
  });
  return { anchors, links: foundLinks, refs, rules };
}

function linkFindings(
  path: string,
  links: readonly Link[],
  entries: ReadonlyMap<string, Entry>,
  documents: ReadonlyMap<string, Document>,
): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const { line, target } of links) {
    if (SCHEME.test(target)) {
      continue;
    }
    const resolved = localTarget(path, target);
    const entry = resolved === null ? undefined : entries.get(resolved.path);
    if (
      resolved === null ||
      sensitivePath(resolved.path) ||
      (resolved.path !== "." && !isFile(entry) && entry?.mode !== "040000")
    ) {
      findings.push({
        code: "broken-link",
        line,
        message: "local target is not a tracked file or directory at HEAD",
        path,
      });
    } else if (resolved.anchor !== "") {
      const document = documents.get(resolved.path);
      if (document !== undefined && !document.anchors.has(resolved.anchor)) {
        findings.push({
          code: "broken-anchor",
          line,
          message: "local Markdown fragment does not resolve at HEAD",
          path,
        });
      }
    }
  }
  return findings;
}

export function readBlob(git: GitRunner, root: string, entry: Entry): string {
  if (!isFile(entry)) {
    throw new Error("docs audit cannot read a non-file Git tree entry");
  }
  return git(root, ["--no-replace-objects", "cat-file", "blob", entry.oid]);
}

/** Assess checked-in Markdown structure at one HEAD. Evidence links are human verification leads. */
export function auditDocs(git: GitRunner, root: string, area?: string): DocsAudit {
  const selected = selection(area);
  const { entries, head } = snapshot(git, root);
  const documents = new Map<string, Document>();
  const decisions = new Map<string, ReadonlySet<string>>();
  const counts = new Map<string, number>();
  for (const [path, entry] of entries) {
    if (!MARKDOWN.test(path) || !isFile(entry) || sensitivePath(path)) {
      continue;
    }
    const body = readBlob(git, root, entry);
    const document = readDocument(path, body);
    documents.set(path, document);
    for (const rule of document.rules) {
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
    }
    const workId = WORK_PATH.exec(path)?.[1];
    if (workId !== undefined && parseFrontMatter(body)?.fields.id === workId) {
      const parsed = parseDecisions(proseLines(body).join("\n"));
      const invalid = new Set(parsed.problems.map(({ line }) => line));
      const occurrences = new Map<string, number>();
      for (const { id } of parsed.decisions) {
        occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
      }
      const ids = new Set(
        parsed.decisions
          .filter(({ id, line }) => occurrences.get(id) === 1 && !invalid.has(line))
          .map(({ id }) => id),
      );
      decisions.set(workId, ids);
    }
  }
  const files = [...documents.keys()].filter(selected).sort();
  if (area !== undefined && files.length === 0) {
    throw new Error("docs audit area has no tracked Markdown at HEAD");
  }
  const findings: AuditFinding[] = [];
  const rules: Rule[] = [];
  for (const path of files) {
    const document = documents.get(path)!;
    findings.push(...linkFindings(path, document.links, entries, documents));
    for (const rule of document.rules) {
      if ((counts.get(rule.id) ?? 0) > 1) {
        findings.push({
          code: "duplicate-rule",
          line: rule.line,
          message: `explicit rule anchor ${rule.id} is repeated in this repository`,
          path,
        });
      }
      rules.push(rule);
    }
    for (const ref of document.refs) {
      if (
        !decisions.has(ref.id) ||
        (ref.decision !== undefined && !decisions.get(ref.id)?.has(ref.decision))
      ) {
        findings.push({
          code: "broken-work-ref",
          line: ref.line,
          message: "exact work or decision reference does not resolve at HEAD",
          path,
        });
      }
    }
  }
  findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.code.localeCompare(right.code),
  );
  return { area: area ?? null, files, findings, head, ok: findings.length === 0, rules };
}
