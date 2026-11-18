// Work files (docs/work/<id>.md) and design index tables (docs/design/*.md) as written by the
// work-file convention. Reads only; nothing here writes the repository.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const WORK_DIR = join("docs", "work");
export const DESIGN_DIR = join("docs", "design");
/** The convention document in docs/work/, which is not a work item. */
export const CONVENTION_FILE = "README.md";

export const STATUSES = ["approved", "done", "cancelled", "superseded"] as const;
export type WorkStatus = (typeof STATUSES)[number];
export const REQUIRED_FIELDS = ["id", "title", "status", "approved", "design"] as const;
export const OPTIONAL_FIELDS = ["related", "supersedes"] as const;

export type FrontMatterValue = string | readonly string[];

export interface FrontMatter {
  readonly fields: Readonly<Record<string, FrontMatterValue>>;
  /** Malformed lines, each as `line N: reason`. */
  readonly problems: readonly string[];
}

export interface WorkFile {
  /** Repository-relative path, for example docs/work/ck-0001.md. */
  readonly path: string;
  /** The file name without .md. */
  readonly stem: string;
  readonly text: string;
  /** Null when the file does not open with a front matter block. */
  readonly frontMatter: FrontMatter | null;
}

export interface IndexRow {
  /** Repository-relative design file holding the row. */
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  readonly id: string;
  readonly title: string;
  /** The link target as written. */
  readonly target: string;
  /**
   * Repository-relative path the target resolves to, or null when it is a URL outside this
   * repository's blob URLs or a path outside the repository.
   */
  readonly resolved: string | null;
}

export interface DesignFile {
  readonly path: string;
  /** The file name without .md: the design area name. */
  readonly area: string;
  readonly text: string;
  readonly rows: readonly IndexRow[];
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  return quoted === null ? value : (quoted[1] ?? "");
}

function scalarOrList(value: string): FrontMatterValue | null {
  if (!value.startsWith("[")) {
    return unquote(value);
  }
  if (!value.endsWith("]")) {
    return null;
  }
  const inner = value.slice(1, -1).trim();
  return inner === "" ? [] : inner.split(",").map((item) => unquote(item.trim()));
}

/** The `---` block at the start of a file: `key: value` lines, values scalar or `[a, b]`. */
export function parseFrontMatter(text: string): FrontMatter | null {
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    return null;
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    return { fields: {}, problems: ["front matter is not closed with ---"] };
  }
  const fields: Record<string, FrontMatterValue> = {};
  const problems: string[] = [];
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/.exec(line);
    if (match === null) {
      problems.push(`line ${index + 1}: expected "key: value"`);
      continue;
    }
    const [, key = "", raw = ""] = match;
    const value = scalarOrList(raw.trim());
    if (value === null) {
      problems.push(`line ${index + 1}: unterminated list for ${key}`);
    } else if (Object.hasOwn(fields, key)) {
      problems.push(`line ${index + 1}: ${key} is repeated`);
    } else {
      fields[key] = value;
    }
  }
  return { fields, problems };
}

function markdownFiles(directory: string): string[] {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md") && statSync(join(directory, name)).isFile())
    .sort();
}

/** Every docs/work/*.md file except the convention document, in name order. */
export function readWorkFiles(root: string): WorkFile[] {
  const directory = join(root, WORK_DIR);
  return markdownFiles(directory)
    .filter((name) => name !== CONVENTION_FILE)
    .map((name) => {
      const text = readFileSync(join(directory, name), "utf8");
      return {
        frontMatter: parseFrontMatter(text),
        path: join(WORK_DIR, name),
        stem: basename(name, ".md"),
        text,
      };
    });
}

function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

const LINK = /^\[[^\]]*\]\(([^)\s]+)\)$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The blob URL prefix of the repository's default branch, `https://github.com/OWNER/REPO/blob/main/`,
 * from the `repository` field of its package.json; null without one or for a non-GitHub repository.
 */
export function repositoryBlobBase(root: string): string | null {
  let repository: unknown;
  try {
    repository = (
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        repository?: unknown;
      }
    ).repository;
  } catch {
    return null;
  }
  const url =
    typeof repository === "string"
      ? repository
      : typeof repository === "object" && repository !== null && "url" in repository
        ? repository.url
        : undefined;
  if (typeof url !== "string") {
    return null;
  }
  const match =
    /^(?:git\+)?https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url) ??
    /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url);
  return match === null ? null : `https://github.com/${match[1]}/${match[2]}/blob/main/`;
}

/** The repository-relative path a link target names, or null when it is outside the repository. */
function resolveTarget(
  root: string,
  base: string | null,
  path: string,
  target: string,
): string | null {
  const [location = ""] = target.split("#");
  let resolved: string;
  if (SCHEME.test(location)) {
    if (base === null || !location.startsWith(base)) {
      return null;
    }
    resolved = relative(root, resolve(root, location.slice(base.length)));
  } else {
    resolved = relative(root, resolve(root, dirname(path), location));
  }
  return resolved === ".." || resolved.startsWith("../") || isAbsolute(resolved) ? null : resolved;
}

/**
 * The rows of every table whose header is exactly `ID | Title | Link`, the work item index of a
 * design area. Other tables, such as the area table in docs/design/README.md, are not indexes.
 */
function indexRows(root: string, base: string | null, path: string, text: string): IndexRow[] {
  const rows: IndexRow[] = [];
  const lines = text.split("\n");
  let inIndex = false;
  lines.forEach((line, index) => {
    const row = cells(line);
    if (row === null) {
      inIndex = false;
      return;
    }
    if (row.length === 3 && row[0] === "ID" && row[1] === "Title" && row[2] === "Link") {
      inIndex = true;
      return;
    }
    if (!inIndex || row.every((cell) => /^:?-+:?$/.test(cell))) {
      return;
    }
    const [id = "", title = "", link = ""] = row;
    const target = LINK.exec(link)?.[1] ?? link;
    rows.push({
      id,
      line: index + 1,
      path,
      resolved: resolveTarget(root, base, path, target),
      target,
      title,
    });
  });
  return rows;
}

/** Every docs/design/*.md file with its work item index rows, in name order. */
export function readDesignFiles(root: string): DesignFile[] {
  const directory = join(root, DESIGN_DIR);
  const base = repositoryBlobBase(root);
  return markdownFiles(directory).map((name) => {
    const path = join(DESIGN_DIR, name);
    const text = readFileSync(join(directory, name), "utf8");
    return { area: basename(name, ".md"), path, rows: indexRows(root, base, path, text), text };
  });
}

/** One field as a string, or undefined when it is absent or a list. */
export function field(file: WorkFile, key: string): string | undefined {
  const value = file.frontMatter?.fields[key];
  return typeof value === "string" ? value : undefined;
}
