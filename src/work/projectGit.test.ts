import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { systemGit } from "../core/git.ts";
import { projectBase, projectCandidate, projectLanding, projectLocalTarget } from "./projectGit.ts";

const BRANCH = "release/stable";
const TARGET = `refs/remotes/upstream/${BRANCH}`;
const git = systemGit(process.env);
const scratch: string[] = [];

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

function commit(root: string, message: string, path: string): string {
  writeFileSync(join(root, path), `${message}\n`);
  run(root, "add", "--", path);
  run(root, "commit", "-m", message);
  return run(root, "rev-parse", "HEAD");
}

function fixture(format = "sha1") {
  const root = mkdtempSync(join(tmpdir(), "project-git-fixture-"));
  scratch.push(root);
  run(root, "init", `--initial-branch=${BRANCH}`, `--object-format=${format}`);
  const baseSha = commit(root, "Approved base", "base.txt");
  run(root, "update-ref", TARGET, baseSha);
  run(root, "switch", "-c", "fixture-candidate");
  const headSha = commit(root, "Reviewed head", "changed path.txt");
  return { candidate: { baseSha, headSha, remoteRef: TARGET }, root };
}

describe("standalone project Git proofs", () => {
  it.each(["sha1", "sha256"])(
    "checks exact commits and an explicit non-main target in %s",
    (format) => {
      const { candidate, root } = fixture(format);
      const { baseSha, headSha } = candidate;
      expect(projectBase(git, root, TARGET)).toBe(baseSha);
      expect(projectLocalTarget(git, root, BRANCH)).toBe(baseSha);
      expect(projectCandidate(git, root, candidate)).toEqual({
        baseSha,
        changedPaths: ["changed path.txt"],
        headSha,
        remoteRef: TARGET,
        targetSha: baseSha,
      });
      expect(run(root, "rev-parse", "HEAD")).toBe(headSha);
      expect(run(root, "status", "--porcelain")).toBe("");
      expect(projectBase(git, root, TARGET)).toBe(baseSha);
    },
  );

  it("requires full commit IDs and an explicit tracking branch", () => {
    const { candidate, root } = fixture();
    const tree = run(root, "rev-parse", "HEAD^{tree}");
    for (const headSha of ["HEAD", candidate.headSha.slice(0, 12), tree]) {
      expect(() => projectCandidate(git, root, { ...candidate, headSha })).toThrow(
        "project-candidate-invalid",
      );
    }
    for (const ref of [
      `refs/heads/${BRANCH}`,
      "refs/remotes/upstream/HEAD",
      "refs/remotes/upstream/../branch",
    ]) {
      expect(() => projectBase(git, root, ref)).toThrow("project-target-ref-invalid");
    }
    expect(() => projectBase(git, root, "refs/remotes/upstream/missing")).toThrow(
      "project-target-unavailable",
    );
    const alias = "refs/remotes/upstream/alias";
    run(root, "symbolic-ref", alias, TARGET);
    expect(() => projectBase(git, root, alias)).toThrow("project-target-unavailable");
  });

  it("distinguishes a later target from a rewritten or unapproved base", () => {
    const { candidate, root } = fixture();
    run(root, "switch", BRANCH);
    const targetSha = commit(root, "Unrelated target advance", "another.txt");
    run(root, "update-ref", TARGET, targetSha);
    expect(projectCandidate(git, root, candidate)).toMatchObject({ targetSha });
    expect(() => projectCandidate(git, root, { ...candidate, baseSha: targetSha })).toThrow(
      "project-candidate-base-mismatch",
    );

    run(root, "switch", "--orphan", "unrelated");
    const rewritten = commit(root, "Other history", "unrelated.txt");
    run(root, "update-ref", TARGET, rewritten);
    expect(() => projectCandidate(git, root, candidate)).toThrow("project-target-base-changed");
  });

  it("refuses unsafe display paths and promisor reads", () => {
    const { candidate, root } = fixture();
    const headSha = commit(root, "Path contains a line break", "line\nbreak.txt");
    expect(() => projectCandidate(git, root, { ...candidate, headSha })).toThrow(
      "project-review-path-unavailable",
    );
    run(root, "config", "remote.upstream.promisor", "true");
    expect(() => projectBase(git, root, TARGET)).toThrow("project-partial-clone-unavailable");
  });

  it("proves exact landing when the reviewed head is reachable from the tracking branch", () => {
    const { candidate, root } = fixture();
    expect(() => projectLanding(git, root, candidate)).toThrow("project-candidate-not-landed");
    const targetSha = commit(root, "Later target commit", "later.txt");
    run(root, "update-ref", TARGET, targetSha);
    expect(projectLanding(git, root, candidate)).toEqual({
      headSha: candidate.headSha,
      kind: "exact",
      landedSha: candidate.headSha,
      targetSha,
    });
  });

  it("proves a provider merge only for the exact reviewed head and on the intended branch", () => {
    const { candidate, root } = fixture();
    run(root, "switch", BRANCH);
    const mergeSha = commit(root, "Provider squash of the reviewed change", "changed path.txt");
    const verified = { headSha: candidate.headSha, mergeSha, remoteRef: TARGET };
    expect(() => projectLanding(git, root, candidate, verified)).toThrow(
      "project-merge-not-landed",
    );
    const targetSha = commit(root, "Later target commit", "later.txt");
    run(root, "update-ref", TARGET, targetSha);
    expect(() => projectLanding(git, root, candidate, { ...verified, headSha: targetSha })).toThrow(
      "project-merge-binding-mismatch",
    );
    expect(() =>
      projectLanding(git, root, candidate, {
        ...verified,
        remoteRef: "refs/remotes/upstream/other",
      }),
    ).toThrow("project-merge-binding-mismatch");
    expect(() =>
      projectLanding(git, root, candidate, { ...verified, mergeSha: candidate.baseSha }),
    ).toThrow("project-merge-not-landed");
    expect(projectLanding(git, root, candidate, verified)).toEqual({
      headSha: candidate.headSha,
      kind: "provider-merge",
      landedSha: mergeSha,
      targetSha,
    });
  });
});
