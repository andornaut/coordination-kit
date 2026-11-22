// The work-file half of `question answer`: the decision line `- D<n> (by, YYYY-MM-DD; answers Q[;
// supersedes Dk]): text`, appended to docs/work/<id>.md in the main checkout of the caller's role
// repository. The file is left unstaged for the role's next commit; nothing is staged or
// committed, and no checkout other than one on `main` is touched.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { writeDurable } from "../durable.ts";
import type { Layout } from "../layout.ts";
import type { Registry } from "../registry/schema.ts";
import { type GitRunner, repositoryRoot } from "../status/git.ts";
import { StoreError } from "./types.ts";

export interface WorkFileTarget {
  /** The main checkout of the role's repository. */
  readonly repository: string;
  /** Absolute path of docs/work/<id>.md in it. */
  readonly path: string;
}

const HEADING = /^## Decisions\s*$/;
const D_LINE = /^- D([1-9][0-9]{0,5}) \(/;
const PLACEHOLDER = /^None yet\.?\s*$/;

/**
 * docs/work/<work>.md in the main checkout of `role`'s repository, found from its registered
 * worktree. Refuses `worktree-unavailable` when Git cannot resolve it, `main-checkout-not-main`
 * when that checkout is not on `main`, and `work-file-missing` when the file is absent.
 */
export function mainWorkFile(
  git: GitRunner,
  layout: Layout,
  registry: Registry,
  role: string,
  work: string,
): WorkFileTarget {
  const record = registry.roles[role];
  if (record === undefined) {
    throw new StoreError("caller-unbound");
  }
  let repository: string;
  let branch: string;
  try {
    repository = repositoryRoot(git, resolve(layout.root, record.worktree));
    branch = git(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  } catch {
    throw new StoreError("worktree-unavailable");
  }
  if (branch !== "main") {
    throw new StoreError("main-checkout-not-main");
  }
  const path = join(repository, "docs", "work", `${work}.md`);
  if (!existsSync(path)) {
    throw new StoreError("work-file-missing");
  }
  if (!lstatSync(path).isFile()) {
    throw new StoreError("work-file-not-regular");
  }
  return { path, repository };
}

function decisionsSection(lines: readonly string[]): { start: number; end: number } {
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start < 0) {
    throw new StoreError("decisions-section-missing");
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^#{1,2} /.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return { end, start };
}

/** The decision numbers a work file's Decisions section already uses. */
export function fileDecisionNumbers(text: string): number[] {
  const lines = text.split("\n");
  const { end, start } = decisionsSection(lines);
  return lines
    .slice(start + 1, end)
    .map((line) => D_LINE.exec(line))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]));
}

export interface DecisionLineInput {
  readonly n: number;
  readonly by: string;
  /** The decision time; its UTC date is written. */
  readonly at: string;
  readonly question: string;
  /** `D<k>`, or null. */
  readonly supersedes: string | null;
  readonly text: string;
}

/** `- D<n> (by, YYYY-MM-DD; answers Q[; supersedes Dk]): text`. */
export function decisionLine(input: DecisionLineInput): string {
  const supersedes = input.supersedes === null ? "" : `; supersedes ${input.supersedes}`;
  return `- D${input.n} (${input.by}, ${input.at.slice(0, 10)}; answers ${input.question}${supersedes}): ${input.text}`;
}

/**
 * Append `line` as decision `n` to the Decisions section: after its last line, replacing a lone
 * `None yet.` placeholder. Repairing a missing line inserts it before any higher-numbered line.
 * Only an exact match is already applied. A different line using that number is a conflict.
 */
export function appendDecisionLine(path: string, n: number, line: string): boolean {
  const metadata = lstatSync(path);
  if (!metadata.isFile()) {
    throw new StoreError("work-file-not-regular");
  }
  const current = readFileSync(path, "utf8");
  const lines = current.split("\n");
  const { end, start } = decisionsSection(lines);
  const body = lines.slice(start + 1, end);
  const content = body
    .map((item, index) => ({ index: start + 1 + index, item }))
    .filter(({ item }) => item.trim() !== "");
  const numbered = content.flatMap(({ index, item }) => {
    const match = D_LINE.exec(item);
    return match === null ? [] : [{ index, item, n: Number(match[1]) }];
  });
  const matches = numbered.filter((entry) => entry.n === n);
  if (matches.length > 0) {
    if (matches.length === 1 && matches[0]!.item === line) {
      return false;
    }
    throw new StoreError("decision-line-conflict");
  }
  const next = numbered.find((entry) => entry.n > n);
  if (next !== undefined) {
    lines.splice(next.index, 0, line);
  } else if (content.length === 1 && PLACEHOLDER.test(content[0]!.item)) {
    lines[content[0]!.index] = line;
  } else if (content.length === 0) {
    lines.splice(start + 1, end - start - 1, "", line, "");
  } else {
    lines.splice(content.at(-1)!.index + 1, 0, line);
  }
  writeDurable(path, lines.join("\n"), {
    mode: metadata.mode & 0o777,
    onStage: (stage) => {
      if (stage === "synced" && readFileSync(path, "utf8") !== current) {
        throw new StoreError("work-file-changed");
      }
    },
  });
  return true;
}
