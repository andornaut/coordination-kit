import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type GitRunner, systemGit } from "../core/git.ts";
import { planDocsCompaction } from "./docsCompact.ts";

const runGit = systemGit(process.env);
const DESIGN = "docs/design/review.md";
const ITEM = "docs/work/ck-0001.md";

function work(id: string, status: string, extra = "", approved = true): string {
  return [
    "---",
    `id: ${id}`,
    "title: Review change",
    `status: ${status}`,
    ...(approved ? ["approved: user, 2026-11-26"] : []),
    "design: review",
    ...(extra === "" ? [] : [extra]),
    "---",
    "",
    "## Decisions",
    "",
    "- D1 (user, 2026-11-26): Keep the rule",
    "",
  ].join("\n");
}

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "ck-docs-compact-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  function write(path: string, content: string): void {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  function commit(): string {
    git("add", "--all");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Documentation fixture",
    );
    return git("rev-parse", "HEAD").trim();
  }
  git("init", "--quiet", "--initial-branch=main");
  for (const [path, content] of Object.entries(files)) {
    write(path, content);
  }
  const head = commit();
  return { commit, git, head, root, write };
}

const OLD_INDEX = [
  "# Review",
  "",
  "## Work items",
  "",
  "| ID | Title | Link |",
  "| --- | --- | --- |",
  "| ck-0001 | Review change | [record](../work/ck-0001.md) |",
  "",
].join("\n");

describe("docs compaction planning", () => {
  it("keeps work status, explicit successors, headings, decisions and inbound reference locations", () => {
    const { git, head, root } = fixture({
      "README.md": "[Archive](docs/work/ck-0001.md#decisions) and `ck-0001/D1`.\n",
      [DESIGN]: OLD_INDEX,
      [ITEM]: work("ck-0001", "superseded"),
      "docs/work/ck-0002.md": work("ck-0002", "done", "supersedes: [ck-0001]"),
      "docs/work/ck-0003.md": work("ck-0003", "approved"),
      "docs/work/ck-0004.md": work("ck-0004", "proposed"),
      "docs/work/task-0001.md": "# Proposal\n\nTask: task-0001\n\n## Approved scope\n\nWork.\n",
    });
    const before = git("status", "--porcelain=v1", "--untracked-files=all");
    const report = planDocsCompaction(runGit, root);
    expect(report).toMatchObject({
      area: null,
      head,
      proposals: [
        { destination: "docs/work/index/review.md", kind: "relocate-index", path: DESIGN },
        {
          area: "review",
          disposition: "needs-owner-runtime-review",
          kind: "terminal-work",
          status: "superseded",
          supersededBy: [{ path: "docs/work/ck-0002.md", status: "done", workId: "ck-0002" }],
          evidence: {
            blob: git("rev-parse", `HEAD:${ITEM}`).trim(),
            decisions: [{ id: "D1", line: 11, supersedes: null }],
            headings: [{ anchor: "decisions", level: 2, line: 9 }],
            inboundLinks: [
              { anchor: "decisions", kind: "link", line: 1, path: "README.md" },
              { anchor: "D1", kind: "decision", line: 1, path: "README.md" },
              { anchor: null, kind: "link", line: 7, path: DESIGN },
              { anchor: null, kind: "work", line: 7, path: "docs/work/ck-0002.md" },
            ],
          },
        },
        { kind: "terminal-work", supersedes: ["ck-0001"], workId: "ck-0002" },
        { kind: "unknown-work", reason: "standalone-status-not-in-git", workId: "task-0001" },
      ],
      schema: 1,
    });
    expect(git("status", "--porcelain=v1", "--untracked-files=all")).toBe(before);
  });

  it("accepts a qualified or short area, including historical work with no file in the design tree", () => {
    const { root } = fixture({
      [DESIGN]: OLD_INDEX,
      [ITEM]: work("ck-0001", "done"),
      "docs/work/ck-0002.md": work("ck-0002", "done").replace("design: review", "design: archived"),
    });
    const short = planDocsCompaction(runGit, root, "review");
    const qualified = planDocsCompaction(runGit, root, "docs/design/review");
    expect(qualified.proposals).toEqual(short.proposals);
    expect(short.proposals.map(({ path }) => path)).toEqual([DESIGN, ITEM]);
    expect(planDocsCompaction(runGit, root, "archived").proposals.map(({ path }) => path)).toEqual([
      "docs/work/ck-0002.md",
    ]);
    expect(() => planDocsCompaction(runGit, root, "../archive")).toThrow(/area/);
    expect(() => planDocsCompaction(runGit, root, "absent")).toThrow(/no tracked Markdown/);
  });

  it("reports retired prose only with a live marker and an approved completed successor", () => {
    const { root } = fixture({
      "README.md": "[Old behaviour](docs/design/review.md#old-behaviour)\n",
      [DESIGN]: [
        "# Review",
        "",
        "<!-- compact: superseded by ck-0001 -->",
        "## Old behaviour",
        "",
        "Example.",
        "",
        "### Details",
        "",
        "<!-- compact: superseded by ck-0002 -->",
        "## Active successor",
        "",
        "<!-- compact: superseded by ck-0003 -->",
        "## Missing approval",
        "",
        "\x60\x60\x60md",
        "<!-- compact: superseded by ck-0001 -->",
        "## Fenced example",
        "\x60\x60\x60",
        "",
        "<!--",
        "<!-- compact: superseded by ck-0001 -->",
        "## Comment example",
        "-->",
      ].join("\n"),
      [ITEM]: work("ck-0001", "done"),
      "docs/work/ck-0002.md": work("ck-0002", "approved"),
      "docs/work/ck-0003.md": work("ck-0003", "done", "", false),
    });
    const proposals = planDocsCompaction(runGit, root).proposals.filter(
      ({ kind }) => kind === "retired-prose",
    );
    expect(proposals).toMatchObject([
      {
        evidence: {
          fromLine: 3,
          headings: [{ anchor: "old-behaviour" }, { anchor: "details" }],
          inboundLinks: [{ anchor: "old-behaviour", path: "README.md" }],
          toLine: 9,
        },
        successor: { path: ITEM, status: "done", workId: "ck-0001" },
      },
    ]);
  });

  it("recognizes a relocated table through equivalent relative and canonical blob links", () => {
    const { root } = fixture({
      [DESIGN]: OLD_INDEX.replace(
        "../work/ck-0001.md",
        "https://github.com/example/project/blob/main/docs/work/ck-0001.md",
      ),
      [ITEM]: work("ck-0001", "done"),
      "docs/work/index/review.md": OLD_INDEX.replace("../work/ck-0001.md", "../ck-0001.md"),
      "package.json": '{"repository":"github:example/project"}\n',
    });
    const report = planDocsCompaction(runGit, root);
    expect(report.proposals).toHaveLength(1);
    expect(report.proposals[0]).toMatchObject({
      kind: "terminal-work",
      evidence: {
        inboundLinks: expect.arrayContaining([
          { anchor: null, kind: "link", line: 7, path: DESIGN },
        ]),
      },
    });
  });

  it("does not open symlink, sensitive-path or untracked Markdown and rejects tracked edits", () => {
    const { commit, git, root, write } = fixture({ [ITEM]: work("ck-0001", "done") });
    symlinkSync("ck-0001.md", join(root, "docs/work/ck-0002.md"));
    write("docs/private/token.md", "Synthetic protected path fixture.\n");
    commit();
    write("docs/work/task-0001.md", "# Local untracked record\n");
    const read = vi.fn<GitRunner>(runGit);
    expect(planDocsCompaction(read, root).proposals.map(({ path }) => path)).toEqual([ITEM]);
    for (const path of ["docs/work/ck-0002.md", "docs/private/token.md"]) {
      const oid = git("rev-parse", `HEAD:${path}`).trim();
      expect(read.mock.calls.some(([, args]) => args.includes(oid))).toBe(false);
    }
    write(ITEM, work("ck-0001", "approved"));
    expect(() => planDocsCompaction(runGit, root)).toThrow(/tracked files clean/);
  });
});
