// The packaged docs against package.json `files`: every listed doc exists, every topic doc and
// design summary is listed or excluded with a `!` entry, and no packaged doc links by relative
// path to a file the package leaves out. Runs in lint, so docs-only changes are covered.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./check.ts";

/** The directories whose Markdown files must each be packaged or deliberately excluded. */
const DOC_DIRS = ["docs", "docs/guides", "docs/reference", "docs/design"];

export interface DocsFinding {
  readonly path: string;
  readonly line?: number;
  readonly message: string;
}

function manifestFiles(root: string): string[] {
  const { files } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    files?: unknown;
  };
  if (!Array.isArray(files) || !files.every((entry) => typeof entry === "string"))
    throw new Error("package.json files must be a list of paths");
  return files;
}

function isDoc(entry: string): boolean {
  return entry === "README.md" || entry.startsWith("docs/");
}

/** The docs package.json `files` lists, the README first: each one an exact file path. */
export function packagedDocs(root: string): string[] {
  return manifestFiles(root).filter((entry) => !entry.startsWith("!") && isDoc(entry));
}

/** The docs package.json `files` excludes with a `!` entry. */
function excludedDocs(root: string): string[] {
  return manifestFiles(root)
    .filter((entry) => entry.startsWith("!"))
    .map((entry) => entry.slice(1))
    .filter(isDoc);
}

/** Markdown with fenced blocks and code spans blanked, so their text is never read as a link. */
function prose(text: string): string[] {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return "";
    }
    return fenced ? "" : line.replace(/`[^`]*`/g, "");
  });
}

const INLINE_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_LINK = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function linkTargets(text: string): { line: number; target: string }[] {
  const targets: { line: number; target: string }[] = [];
  prose(text).forEach((line, index) => {
    for (const match of line.matchAll(INLINE_LINK))
      targets.push({ line: index + 1, target: match[1] ?? "" });
    const reference = REFERENCE_LINK.exec(line);
    if (reference !== null) targets.push({ line: index + 1, target: reference[1] ?? "" });
  });
  return targets;
}

export function docsFindings(root: string): DocsFinding[] {
  const findings: DocsFinding[] = [];
  const packaged = packagedDocs(root);
  const excluded = new Set(excludedDocs(root));
  const listed = new Set(packaged);
  for (const doc of packaged) {
    const path = join(root, doc);
    if (!existsSync(path) || !statSync(path).isFile())
      findings.push({ message: "is listed in package.json files but is not a file", path: doc });
    if (excluded.has(doc))
      findings.push({ message: "is both listed and excluded in package.json files", path: doc });
  }
  for (const directory of DOC_DIRS) {
    for (const name of readdirSync(join(root, directory)).sort()) {
      const doc = `${directory}/${name}`;
      if (name.endsWith(".md") && statSync(join(root, doc)).isFile())
        if (!listed.has(doc) && !excluded.has(doc))
          findings.push({
            message: "is neither listed nor excluded in package.json files",
            path: doc,
          });
    }
  }
  // A packaged directory is one that holds a packaged file, such as docs/reference/ for commands.md.
  const shipped = (target: string) =>
    manifestFiles(root).some(
      (entry) => !entry.startsWith("!") && (entry === target || entry.startsWith(`${target}/`)),
    );
  for (const doc of packaged) {
    const path = join(root, doc);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    for (const { line, target } of linkTargets(readFileSync(path, "utf8"))) {
      const [location = ""] = target.split("#");
      if (location === "" || SCHEME.test(location) || location.startsWith("//")) continue;
      const resolved = relative(root, resolve(root, dirname(doc), decodeURI(location)));
      if (resolved === "") continue;
      if (resolved === ".." || resolved.startsWith("../") || isAbsolute(resolved))
        findings.push({ line, message: `links outside the package: ${target}`, path: doc });
      else if (!existsSync(join(root, resolved)))
        findings.push({ line, message: `links to a missing file: ${target}`, path: doc });
      else if (!shipped(resolved))
        findings.push({
          line,
          message: `links by relative path to ${resolved}, which is not packaged; use the repository URL`,
          path: doc,
        });
    }
  }
  return findings;
}

if (isMain(import.meta.url)) {
  try {
    const findings = docsFindings(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
    for (const { line, message, path } of findings)
      console.error(`docs-check: ${path}${line === undefined ? "" : `:${line}`}: ${message}`);
    if (findings.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error("docs-check: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
