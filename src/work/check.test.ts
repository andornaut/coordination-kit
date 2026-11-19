import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, main } from "../cli.ts";
import { checkWork, type FindingCode } from "./check.ts";
import { parseFrontMatter } from "./files.ts";

/** A copy of delivery-kit 4.7.0's docs/design and docs/work. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "delivery-kit");

function copy(): string {
  const root = mkdtempSync(join(tmpdir(), "work-check-"));
  cpSync(FIXTURE, root, { recursive: true });
  return root;
}

function edit(root: string, path: string, change: (text: string) => string): void {
  const file = join(root, path);
  writeFileSync(file, change(readFileSync(file, "utf8")));
}

function codes(root: string): FindingCode[] {
  return checkWork(root).findings.map((finding) => finding.code);
}

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: "/nonexistent", env: {}, err: (text) => (err += text), out: (text) => (out += text) },
    argv,
  );
  return { code, err, out };
}

describe("parseFrontMatter", () => {
  it("reads scalars and inline lists and names malformed lines", () => {
    expect(
      parseFrontMatter("---\nid: ck-0001\nrelated: [ck-0002, ck-0003]\nempty: []\n---\n"),
    ).toEqual({
      fields: { empty: [], id: "ck-0001", related: ["ck-0002", "ck-0003"] },
      problems: [],
    });
    expect(parseFrontMatter("# Title\n")).toBeNull();
    expect(parseFrontMatter("---\nid ck-0001\nid: a\nid: b\nrelated: [a\n---\n")?.problems).toEqual(
      [
        'line 2: expected "key: value"',
        "line 4: id is repeated",
        "line 5: unterminated list for related",
      ],
    );
    expect(parseFrontMatter("---\nid: a\n")?.problems).toEqual([
      "front matter is not closed with ---",
    ]);
  });
});

describe("checkWork", () => {
  it("accepts delivery-kit's own design indexes and work files", () => {
    expect(checkWork(FIXTURE)).toEqual({ designAreas: 7, findings: [], ok: true, workItems: 18 });
  });

  it("requires every work file to be indexed exactly once, in its own area", () => {
    const root = copy();
    edit(root, "docs/design/review.md", (text) =>
      text
        .replace(/^\| dk-0005 .*\n/m, "")
        .concat("| dk-0003 | Moved | [dk-0003.md](../work/dk-0003.md) |\n"),
    );
    const findings = checkWork(root).findings;
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "unindexed", path: "docs/work/dk-0005.md" }),
    );
    expect(findings.filter((finding) => finding.code === "index-duplicate")).toHaveLength(2);
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "index-area-mismatch", path: "docs/design/review.md" }),
    );
  });

  it("requires every indexed link to resolve and its row ID to match", () => {
    const root = copy();
    edit(root, "docs/design/runner.md", (text) =>
      text
        .replace("(../work/dk-0016.md)", "(../work/dk-9999.md)")
        .replace("| dk-0017 |", "| dk-0071 |"),
    );
    const findings = checkWork(root).findings;
    expect(findings).toContainEqual(
      expect.objectContaining({
        code: "index-link-unresolved",
        message: "link ../work/dk-9999.md does not resolve",
        path: "docs/design/runner.md",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "index-id-mismatch", path: "docs/design/runner.md" }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "unindexed", path: "docs/work/dk-0016.md" }),
    );
  });

  it("accepts index links as this repository's blob URLs and refuses other locations", () => {
    const root = copy();
    const base = "https://github.com/example/fixture-kit/blob/main";
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        repository: { type: "git", url: "git+https://github.com/example/fixture-kit.git" },
      }),
    );
    edit(root, "docs/design/runner.md", (text) =>
      text
        .replace("(../work/dk-0016.md)", `(${base}/docs/work/dk-0016.md)`)
        .replace("(../work/dk-0017.md)", `(${base}/docs/work/dk-9999.md)`),
    );
    edit(root, "docs/design/review.md", (text) =>
      text.replace(
        "(../work/dk-0005.md)",
        "(https://github.com/example/other-kit/blob/main/docs/work/dk-0005.md)",
      ),
    );
    const findings = checkWork(root).findings;
    expect(findings.map(({ code, message, path }) => ({ code, message, path }))).toEqual([
      {
        code: "index-link-unresolved",
        message:
          "link https://github.com/example/other-kit/blob/main/docs/work/dk-0005.md is outside this repository",
        path: "docs/design/review.md",
      },
      {
        code: "index-link-unresolved",
        message: `link ${base}/docs/work/dk-9999.md does not resolve`,
        path: "docs/design/runner.md",
      },
      {
        code: "unindexed",
        message: "is not listed in any design index table",
        path: "docs/work/dk-0005.md",
      },
      {
        code: "unindexed",
        message: "is not listed in any design index table",
        path: "docs/work/dk-0017.md",
      },
    ]);
  });

  it("refuses a blob URL in a repository whose package.json names no GitHub repository", () => {
    const root = copy();
    edit(root, "docs/design/runner.md", (text) =>
      text.replace(
        "(../work/dk-0016.md)",
        "(https://github.com/example/fixture-kit/blob/main/docs/work/dk-0016.md)",
      ),
    );
    expect(codes(root)).toEqual(["index-link-unresolved", "unindexed"]);
  });

  it("requires the front-matter fields, a valid status, a known design and the file's ID", () => {
    const root = copy();
    edit(root, "docs/work/dk-0001.md", (text) =>
      text.replace(
        "title: Accept Claude route targets in inbox snapshot and ack\n",
        "assignee: me\n",
      ),
    );
    edit(root, "docs/work/dk-0002.md", (text) => text.replace("status: done", "status: shipped"));
    edit(root, "docs/work/dk-0003.md", (text) => text.replace(/^design: .*$/m, "design: nowhere"));
    edit(root, "docs/work/dk-0004.md", (text) => text.replace("id: dk-0004", "id: dk-4"));
    edit(root, "docs/work/dk-0006.md", (text) => text.replace(/^---\n/, ""));
    expect(codes(root)).toEqual([
      "index-id-mismatch",
      "field-missing",
      "field-unknown",
      "status-invalid",
      "design-unknown",
      "id-invalid",
      "id-mismatch",
      "front-matter-missing",
    ]);
  });

  it("accepts an owner and decision lines, and reports malformed ones by line", () => {
    const root = copy();
    edit(root, "docs/work/dk-0002.md", (text) =>
      text.replace(/^design: (.*)$/m, "design: $1\nowner: delivery-kit"),
    );
    const decisions = [
      "",
      "## Decisions",
      "",
      "- D1 (user, 2026-11-18): Keep the queue.",
      "- D2 (user, 2026-11-19; answers q-delivery-kit-3; supersedes D1): Use the store.",
      "- D3 (game-coordinator, 2026-11-19; supersedes dk-0001/D1): Follow the policy.",
      "- Prose that is not a decision.",
      "",
    ].join("\n");
    edit(root, "docs/work/dk-0003.md", (text) => `${text}${decisions}`);
    expect(checkWork(root)).toMatchObject({ findings: [], ok: true });
    edit(root, "docs/work/dk-0004.md", (text) =>
      text
        .replace(/^design: (.*)$/m, "design: $1\nowner: Two Roles")
        .concat(
          [
            "",
            "## Decisions",
            "",
            "- D1 (user, 2026-11-18) Missing colon.",
            "- D2 (user, 2026-02-30): Not a date.",
            "- D3 (user, 2026-11-18; supersedes D9): Unknown target.",
            "- D3 (user, 2026-11-18): Repeated.",
            "",
          ].join("\n"),
        ),
    );
    const findings = checkWork(root).findings.filter((f) => f.path === "docs/work/dk-0004.md");
    expect(findings.map((finding) => finding.code)).toEqual([
      "field-invalid",
      "decision-invalid",
      "decision-invalid",
      "decision-invalid",
      "decision-invalid",
    ]);
    expect(findings.filter((f) => f.code === "decision-invalid").every((f) => f.line! > 0)).toBe(
      true,
    );
  });

  it("accepts proposed and declined items as well as the other statuses", () => {
    const root = copy();
    edit(root, "docs/work/dk-0002.md", (text) => text.replace("status: done", "status: proposed"));
    edit(root, "docs/work/dk-0003.md", (text) => text.replace(/^status: .*$/m, "status: declined"));
    expect(checkWork(root)).toMatchObject({ findings: [], ok: true });
  });

  it("requires unique IDs and existing supersedes targets", () => {
    const root = copy();
    edit(root, "docs/work/dk-0008.md", (text) => text.replace("id: dk-0008", "id: dk-0007"));
    edit(root, "docs/work/dk-0009.md", (text) =>
      text.replace(/^design: (.*)$/m, "design: $1\nsupersedes: dk-0404"),
    );
    const findings = checkWork(root).findings;
    expect(
      findings.filter((finding) => finding.code === "id-duplicate").map((f) => f.path),
    ).toEqual(["docs/work/dk-0007.md", "docs/work/dk-0008.md"]);
    expect(findings).toContainEqual({
      code: "supersedes-missing",
      message: "supersedes dk-0404, which is not a work item",
      path: "docs/work/dk-0009.md",
    });
  });

  it("finds home-directory paths and session UUIDs without echoing them", () => {
    const root = copy();
    const path = ["", "home", "someone", "src"].join("/");
    appendFileSync(join(root, "docs/work/dk-0010.md"), `\nSee ${path}.\n`);
    appendFileSync(
      join(root, "docs/design/registry.md"),
      "\n0f8fad5b-d9cb-469f-a165-70867728950e\n",
    );
    appendFileSync(join(root, "docs/work/README.md"), `\n${["", "Users", "x"].join("/")}/notes\n`);
    const findings = checkWork(root).findings.filter((finding) =>
      ["home-path", "session-uuid"].includes(finding.code),
    );
    expect(findings.map(({ code, path: at }) => [at, code])).toEqual([
      ["docs/design/registry.md", "session-uuid"],
      ["docs/work/README.md", "home-path"],
      ["docs/work/dk-0010.md", "home-path"],
    ]);
    expect(JSON.stringify(findings)).not.toContain("someone");
  });

  it("reports a repository without docs/work, and every index link it leaves dangling", () => {
    const root = copy();
    rmSync(join(root, "docs", "work"), { recursive: true });
    const found = codes(root);
    expect(found.filter((code) => code === "work-dir-missing")).toHaveLength(1);
    expect(found.filter((code) => code === "index-link-unresolved")).toHaveLength(18);
    expect(found).toHaveLength(19);
  });
});

describe("work check command", () => {
  it("prints the result as JSON, names each finding on stderr and exits by outcome", async () => {
    const passed = await cli("work", "check", "--root", FIXTURE);
    expect(passed).toMatchObject({ code: EXIT_OK, err: "" });
    expect(JSON.parse(passed.out)).toMatchObject({ ok: true, workItems: 18 });
    const root = copy();
    edit(root, "docs/work/dk-0002.md", (text) => text.replace("status: done", "status: shipped"));
    const failed = await cli("work", "check", "--root", root);
    expect(failed.code).toBe(EXIT_INVALID);
    expect(JSON.parse(failed.out).findings).toHaveLength(1);
    expect(failed.err).toBe(
      "coordination-kit: docs/work/dk-0002.md: status-invalid: " +
        "status must be one of proposed, approved, done, declined, cancelled, superseded\n",
    );
    expect((await cli("work", "check", "--root", root, "--game", "x")).code).toBe(EXIT_USAGE);
  });

  it("checks the working directory without --root, whatever the coordinator variables", async () => {
    let out = "";
    const code = await main(
      {
        cwd: FIXTURE,
        env: { COORDINATION_KIT_ROOT: "/nonexistent", DELIVERY_KIT_ROOT: "/nonexistent" },
        err: () => undefined,
        out: (text) => (out += text),
      },
      ["work", "check"],
    );
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(out)).toMatchObject({ ok: true, workItems: 18 });
  });
});
