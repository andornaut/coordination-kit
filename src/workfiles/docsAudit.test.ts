import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { systemGit } from "../core/git.ts";
import { auditDocs } from "./docsAudit.ts";

const scratch: string[] = [];
const git = systemGit(process.env);
const markdown = (lines: readonly string[]) => `${lines.join("\n")}\n`;

afterEach(() => {
  for (const path of scratch.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function run(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function put(root: string, path: string, body: string): void {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "docs-audit-fixture-"));
  scratch.push(root);
  run(root, "init", "-b", "main");
  for (const [path, body] of Object.entries(files)) {
    put(root, path, body);
  }
  commit(root);
  return root;
}

function commit(root: string): void {
  run(root, "add", ".");
  run(root, "commit", "-m", "Fixture documents");
}

describe("committed documentation audit", () => {
  it("resolves tracked Markdown, heading fragments and explicit anchors across nested topics", () => {
    const root = fixture({
      "README.md": "# Project\n",
      "docs/design/gameplay.md": markdown([
        "# Gameplay",
        "",
        "[standard](gameplay/controls.md#charge--release)",
        "[repeat](gameplay/controls.md#charge--release-1)",
        "[setext](gameplay/controls.md#hold-the-line)",
        "[explicit](gameplay/controls.md#exact-check)",
        "[general](/docs/Guide%20Notes.md#setup)",
        "[guide][guide-ref]",
        "[guide-ref]: <../Guide Notes.md#setup>",
        "[tracked directory](gameplay/)",
        "[external](https://github.com/andornaut/example/blob/1111111/no-check.md#missing)",
        "",
        "~~~markdown",
        "[ignored](not-present.md)",
        '<a id="rule-ignored"></a>',
        "~~~",
        "",
        "<!-- [ignored](not-present.md) -->",
      ]),
      "docs/design/gameplay/controls.md": markdown([
        "# Charge & Release",
        "# Charge & Release",
        "Hold the Line",
        "-------------",
        '<a id="exact-check"></a>',
      ]),
      "docs/Guide Notes.md": "# Setup\n",
      "docs/gameplay.md": "# Gameplay user guide\n",
    });

    expect(auditDocs(git, root, "gameplay")).toEqual({
      area: "gameplay",
      files: ["docs/design/gameplay.md", "docs/design/gameplay/controls.md", "docs/gameplay.md"],
      findings: [],
      head: run(root, "rev-parse", "HEAD"),
      ok: true,
      rules: [],
    });
    expect(auditDocs(git, root, "docs/design/gameplay").files).toEqual([
      "docs/design/gameplay.md",
      "docs/design/gameplay/controls.md",
    ]);
  });

  it("reports a tagged rule, its evidence leads and duplicate markers even across area scope", () => {
    const root = fixture({
      "docs/design/play.md": markdown([
        '<a id="rule-play-safe"></a>',
        "## Play safely",
        "",
        "**Evidence:** [implementation](../../src/play.ts), `app-0001/D1`, [design](https://example.invalid/ref)",
        "Evidence: `app-0001` and `app-0001/D2`",
        "## Separate section",
        "Evidence: `app-9000`",
        "## Rule-looking heading",
        "Evidence: `app-9001`",
        "[broken fragment](#not-a-heading)",
      ]),
      "docs/review.md": '<a name="rule-play-safe"></a>\n# Review\n',
      "docs/work/app-0001.md": markdown([
        "---",
        "id: app-0001",
        "---",
        "",
        "## Decisions",
        "",
        "- D1 (user, 2026-11-25): Cover a review.",
        "",
        "```",
        "- D2 (user, 2026-11-25): An example.",
        "```",
      ]),
      "src/play.ts": "export const safe = true;\n",
    });
    const { findings, ok, rules } = auditDocs(git, root, "play");
    expect(ok).toBe(false);
    expect(findings.map(({ code, line, path }) => ({ code, line, path }))).toEqual([
      { code: "duplicate-rule", line: 1, path: "docs/design/play.md" },
      { code: "broken-work-ref", line: 5, path: "docs/design/play.md" },
      { code: "broken-anchor", line: 10, path: "docs/design/play.md" },
    ]);
    expect(rules).toEqual([
      {
        behavior: "unverified",
        evidence: [
          { kind: "local", line: 4, target: "../../src/play.ts" },
          { kind: "external", line: 4, target: "https://example.invalid/ref" },
          { kind: "decision", line: 4, target: "app-0001/D1" },
          { kind: "work", line: 5, target: "app-0001" },
          { kind: "decision", line: 5, target: "app-0001/D2" },
        ],
        id: "rule-play-safe",
        line: 1,
        path: "docs/design/play.md",
      },
    ]);
  });

  it("leaves untracked, sensitive and symlink contents unread and rejects an escaping target", () => {
    const root = fixture({
      "README.md": markdown([
        "[untracked](untracked.md)",
        "[out-of-tree](../somewhere.md)",
        "[symbolic](redirect.md#wrong)",
        "[private](secrets/local.md)",
      ]),
      "secrets/local.md": '<a id="rule-sensitive"></a>\n',
    });
    symlinkSync("../outside.md", join(root, "redirect.md"));
    commit(root);
    put(root, "untracked.md", '<a id="rule-untracked"></a>\n');
    const readmeOid = run(root, "rev-parse", "HEAD:README.md");
    const audit = auditDocs((cwd, args) => {
      if (args.includes("cat-file")) {
        expect(args.at(-1)).toBe(readmeOid);
      }
      return git(cwd, args);
    }, root);
    expect(audit.files).toEqual(["README.md"]);
    expect(audit.rules).toEqual([]);
    expect(audit.findings.map(({ code, line }) => [code, line])).toEqual([
      ["broken-link", 1],
      ["broken-link", 2],
      ["broken-link", 3],
      ["broken-link", 4],
    ]);
  });

  it("rejects a dirty or wrong checkout root and unknown or escaping topic", () => {
    const root = fixture({ "docs/how-to.md": "# How to\n" });
    expect(() => auditDocs(git, join(root, "docs"))).toThrow(/Git checkout root/);
    expect(() => auditDocs(git, root, "../docs")).toThrow(/area must be/);
    expect(() => auditDocs(git, root, "unknown")).toThrow(/no tracked Markdown/);
    put(root, "docs/how-to.md", "# Edited\n");
    expect(() => auditDocs(git, root)).toThrow(/tracked files clean/);
  });
});
