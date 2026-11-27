// The packaged-docs check against fixture trees and this repository.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { docsFindings, packagedDocs } from "./docs-check.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK_URL = "https://github.com/example/fixture-kit/blob/main/docs/work/ck-0001.md";

/** A tree with the given package.json files list and docs, each path mapped to its text. */
function tree(files: string[], docs: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "docs-check-"));
  mkdirSync(join(directory, "docs", "design"), { recursive: true });
  mkdirSync(join(directory, "docs", "guides"));
  mkdirSync(join(directory, "docs", "reference"));
  mkdirSync(join(directory, "docs", "work"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ files }));
  for (const [path, text] of Object.entries(docs)) {
    writeFileSync(join(directory, path), text);
  }
  return directory;
}

const FILES = [
  "dist",
  "README.md",
  "docs/reference/commands.md",
  "docs/design/README.md",
  "LICENSE",
];
const DOCS = {
  "README.md":
    "See [commands](docs/reference/commands.md#usage), [design](docs/design/) and [home](#top).\n",
  "docs/reference/commands.md": `Back to [README](../../README.md); work items are [on GitHub](${WORK_URL}).\n`,
  "docs/design/README.md": "Topic docs are in [docs/](..).\n",
  "docs/work/ck-0001.md": "---\nid: ck-0001\n---\n",
};

describe("docsFindings", () => {
  it("passes this repository", () => {
    expect(docsFindings(root)).toEqual([]);
    expect(packagedDocs(root)).toContain("docs/design/packaging.md");
    expect(packagedDocs(root).filter((doc) => doc.startsWith("docs/work/"))).toEqual([]);
  });

  it("passes a tree whose packaged docs link only to packaged files and URLs", () => {
    expect(docsFindings(tree(FILES, DOCS))).toEqual([]);
  });

  it("reports a listed doc that does not exist", () => {
    expect(docsFindings(tree([...FILES, "docs/gone.md"], DOCS))).toEqual([
      { message: "is listed in package.json files but is not a file", path: "docs/gone.md" },
    ]);
  });

  it("reports a doc that is neither listed nor excluded, and accepts an excluded one", () => {
    const docs = {
      ...DOCS,
      "docs/design/draft.md": "# Draft\n",
      "docs/guides/notes.md": "# Notes\n",
    };
    expect(docsFindings(tree([...FILES, "!docs/design/draft.md"], docs))).toEqual([
      {
        message: "is neither listed nor excluded in package.json files",
        path: "docs/guides/notes.md",
      },
    ]);
  });

  it("reports a relative link from a packaged doc to an unpackaged file", () => {
    const docs = {
      ...DOCS,
      "docs/design/README.md": [
        "Work items are in [docs/work/](../work/ck-0001.md#scope).",
        "",
        "Code like `[x](../work/ck-0001.md)` is not a link.",
        "",
        "```md",
        "[fenced](../work/ck-0001.md)",
        "```",
        "",
        "[missing]: ../absent.md",
        "",
      ].join("\n"),
    };
    expect(docsFindings(tree(FILES, docs))).toEqual([
      {
        line: 1,
        message:
          "links by relative path to docs/work/ck-0001.md, which is not packaged; use the repository URL",
        path: "docs/design/README.md",
      },
      { line: 9, message: "links to a missing file: ../absent.md", path: "docs/design/README.md" },
    ]);
  });
});
