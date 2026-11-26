// Standalone project proof reads only local objects and exact refs.
import type { GitRunner } from "../core/git.ts";
import { secretShape } from "../store/secrets.ts";
import { StoreError } from "../store/types.ts";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const TRACKING_BRANCH = /^refs\/remotes\/[^/]+\/(?!HEAD$).+$/;
const UNSAFE_PATH = /[\p{Cc}\p{Cf}\uFFFD]/u;

/** The approved base, exact reviewed head and configured remote-tracking branch. */
export interface ProjectGitCandidate {
  readonly baseSha: string;
  readonly headSha: string;
  readonly remoteRef: string;
}

/** Exact merge metadata after independent provider verification. */
export interface ProjectVerifiedMerge {
  readonly headSha: string;
  readonly mergeSha: string;
  readonly remoteRef: string;
}

function read(git: GitRunner, repository: string, args: readonly string[], reason: string): string {
  try {
    return git(repository, ["--no-replace-objects", ...args]);
  } catch {
    throw new StoreError(reason);
  }
}

/** A promisor repository may fetch missing objects even during a Git read. */
function requireLocalObjects(git: GitRunner, repository: string): void {
  let partial = "";
  try {
    partial = git(repository, [
      "config",
      "--name-only",
      "--get-regexp",
      "^(extensions\\.partialclone|remote\\..*\\.promisor)$",
    ]);
  } catch {
    // Git exits 1 when these settings are absent. Exact object reads still must succeed.
  }
  if (partial !== "") {
    throw new StoreError("project-partial-clone-unavailable");
  }
}

function requireCommit(git: GitRunner, repository: string, sha: string, reason: string): string {
  if (!FULL_SHA.test(sha)) {
    throw new StoreError(reason);
  }
  const resolved = read(git, repository, ["rev-parse", "--verify", `${sha}^{commit}`], reason);
  if (resolved.trim() !== sha) {
    throw new StoreError(reason);
  }
  return sha;
}

function refCommit(git: GitRunner, repository: string, ref: string): string {
  read(git, repository, ["check-ref-format", ref], "project-target-ref-invalid");
  const output = read(
    git,
    repository,
    ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", ref],
    "project-target-unavailable",
  );
  const match = output
    .split("\n")
    .map((line) => line.split("\0"))
    .find(([name]) => name === ref);
  const [, sha, symbolic] = match ?? [];
  if (sha === undefined || symbolic !== "") {
    throw new StoreError("project-target-unavailable");
  }
  return requireCommit(git, repository, sha, "project-target-unavailable");
}

/** Resolve one explicit local remote-tracking branch without fetching or resolving remote HEAD. */
export function projectBase(git: GitRunner, repository: string, remoteRef: string): string {
  if (!TRACKING_BRANCH.test(remoteRef)) {
    throw new StoreError("project-target-ref-invalid");
  }
  requireLocalObjects(git, repository);
  return refCommit(git, repository, remoteRef);
}

/** Resolve the exact local branch, even when another branch is checked out. */
export function projectLocalTarget(git: GitRunner, repository: string, branch: string): string {
  if (branch === "" || branch === "HEAD" || branch.startsWith("-")) {
    throw new StoreError("project-target-ref-invalid");
  }
  requireLocalObjects(git, repository);
  return refCommit(git, repository, `refs/heads/${branch}`);
}

function ancestor(git: GitRunner, repository: string, base: string, head: string): boolean {
  try {
    git(repository, ["--no-replace-objects", "merge-base", "--is-ancestor", base, head]);
    return true;
  } catch {
    return false;
  }
}

function checkedTarget(git: GitRunner, repository: string, candidate: ProjectGitCandidate): string {
  const { baseSha, headSha, remoteRef } = candidate;
  const targetSha = projectBase(git, repository, remoteRef);
  requireCommit(git, repository, baseSha, "project-base-invalid");
  requireCommit(git, repository, headSha, "project-candidate-invalid");
  if (!ancestor(git, repository, baseSha, targetSha)) {
    throw new StoreError("project-target-base-changed");
  }
  if (!ancestor(git, repository, baseSha, headSha)) {
    throw new StoreError("project-candidate-base-mismatch");
  }
  return targetSha;
}

/** Validate the candidate and read only file names for the chat review. */
export function projectCandidate(
  git: GitRunner,
  repository: string,
  candidate: ProjectGitCandidate,
): ProjectGitCandidate & { readonly targetSha: string; readonly changedPaths: readonly string[] } {
  const { baseSha, headSha, remoteRef } = candidate;
  const targetSha = checkedTarget(git, repository, candidate);
  const raw = read(
    git,
    repository,
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      baseSha,
      headSha,
      "--",
    ],
    "project-diff-unavailable",
  );
  const changedPaths = raw.split("\0").slice(0, -1);
  if (
    (raw !== "" && !raw.endsWith("\0")) ||
    changedPaths.some((path) => path === "" || UNSAFE_PATH.test(path) || secretShape(path) !== null)
  ) {
    throw new StoreError("project-review-path-unavailable");
  }
  return { baseSha, changedPaths, headSha, remoteRef, targetSha };
}

/** Verify the supplied provider merge or, for a direct push, the exact reviewed head. */
export function projectLanding(
  git: GitRunner,
  repository: string,
  candidate: ProjectGitCandidate,
  verifiedMerge?: ProjectVerifiedMerge,
): {
  readonly headSha: string;
  readonly landedSha: string;
  readonly targetSha: string;
  readonly kind: "exact" | "provider-merge";
} {
  const { baseSha, headSha, remoteRef } = candidate;
  const targetSha = checkedTarget(git, repository, candidate);
  if (verifiedMerge === undefined) {
    if (!ancestor(git, repository, headSha, targetSha)) {
      throw new StoreError("project-candidate-not-landed");
    }
    return { headSha, kind: "exact", landedSha: headSha, targetSha };
  }
  if (verifiedMerge.headSha !== headSha || verifiedMerge.remoteRef !== remoteRef) {
    throw new StoreError("project-merge-binding-mismatch");
  }
  const landedSha = requireCommit(git, repository, verifiedMerge.mergeSha, "project-merge-invalid");
  if (
    landedSha === baseSha ||
    !ancestor(git, repository, baseSha, landedSha) ||
    !ancestor(git, repository, landedSha, targetSha)
  ) {
    throw new StoreError("project-merge-not-landed");
  }
  return { headSha, kind: "provider-merge", landedSha, targetSha };
}
