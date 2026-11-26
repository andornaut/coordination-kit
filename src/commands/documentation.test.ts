import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { main } from "../cli.ts";
import { systemGit } from "../core/git.ts";

it("audits a committed topic and requires explicit read-only compaction planning", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-docs-"));
  const git = systemGit({});
  const invoke = async (...args: string[]) => {
    let out = "";
    let err = "";
    const code = await main(
      {
        cwd: root,
        env: { COORDINATION_KIT_ROOT: "/unavailable" },
        err: (value) => (err += value),
        out: (value) => (out += value),
      },
      args,
    );
    return { code, err, out };
  };
  try {
    git(root, ["init", "-q", "-b", "main"]);
    mkdirSync(join(root, "docs/design"), { recursive: true });
    mkdirSync(join(root, "docs/work"), { recursive: true });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/rule.ts"), "export const jump = true;\n");
    writeFileSync(
      join(root, "docs/design/gameplay.md"),
      [
        "# Gameplay",
        "",
        '<a id="rule-jump"></a>',
        "",
        "## Jump",
        "",
        "A jump is available on the ground.",
        "",
        "Evidence: [Jump implementation](../../src/rule.ts), `game-0001/D1`.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "docs/work/game-0001.md"),
      [
        "---",
        "id: game-0001",
        "title: Define jumping",
        "status: done",
        "approved: user, 2026-11-26",
        "design: gameplay",
        "---",
        "",
        "## Decisions",
        "",
        "- D1 (user, 2026-11-26): A jump is available on the ground.",
        "",
      ].join("\n"),
    );
    git(root, ["add", "docs", "src"]);
    git(root, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "docs",
    ]);
    const head = git(root, ["rev-parse", "HEAD"]).trim();

    const audit = await invoke("docs", "audit", "--area", "gameplay", "--format", "json");
    expect(audit).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(audit.out)).toMatchObject({
      head,
      rules: [{ behavior: "unverified", id: "rule-jump" }],
    });

    expect(await invoke("docs", "compact")).toMatchObject({ code: 2, out: "" });
    const plan = await invoke("docs", "compact", "--plan", "--format", "json");
    expect(plan).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(plan.out)).toMatchObject({
      head,
      proposals: [{ disposition: "needs-owner-runtime-review", path: "docs/work/game-0001.md" }],
    });
    expect(git(root, ["status", "--porcelain"])).toBe("");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
