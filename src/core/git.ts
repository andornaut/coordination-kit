// Read-only Git access for `status`: repository resolution, one history pass over local `main` and
// `origin/main`, and one pass over the work files on `main`. Every call reads local refs and objects
// only; nothing fetches, checks out or writes.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

/** Runs one read-only git command in `cwd` and returns stdout; throws on a nonzero exit. */
export type GitRunner = (cwd: string, args: readonly string[]) => string;

class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Environment for a read-only git child: no caller GIT_* redirection, no prompt, no optional locks. */
function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("GIT_")) {
      result[key] = value;
    }
  }
  return { ...result, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

/** The git runner over the real binary. `onCall` counts invocations for the performance bound. */
export function systemGit(
  env: NodeJS.ProcessEnv,
  onCall?: () => void,
  timeout?: number,
  options?: { readonly localOnly: boolean },
): GitRunner {
  const environment = gitEnvironment(env);
  if (options?.localOnly === true) {
    environment.GIT_ALLOW_PROTOCOL = "";
    environment.GIT_NO_LAZY_FETCH = "1";
  }
  return (cwd, args) => {
    onCall?.();
    const result = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "-c", "log.showSignature=false", ...args],
      { cwd, encoding: "utf8", env: environment, maxBuffer: 1024 * 1024 * 1024, timeout },
    );
    if (result.error !== undefined) {
      throw new GitError(`git-unavailable: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new GitError(`git-failed: ${result.stderr.trim().split("\n")[0] ?? ""}`);
    }
    return result.stdout;
  };
}

/** Keep object reads local even in a partial clone. */
export function localGit(env: NodeJS.ProcessEnv): GitRunner {
  return systemGit(env, undefined, undefined, { localOnly: true });
}

/** The main checkout of the repository a worktree belongs to: the parent of its common Git dir. */
export function repositoryRoot(git: GitRunner, worktree: string): string {
  const [, common = ""] = git(worktree, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ])
    .trim()
    .split("\n");
  if (common === "") {
    throw new GitError("git-common-dir-unavailable");
  }
  return common.endsWith("/.git") ? dirname(common) : common;
}

interface Change {
  /** A, M, D, R, C or T. */
  readonly status: string;
  readonly path: string;
  /** The source path of a rename or copy. */
  readonly from?: string;
}

export interface Commit {
  readonly sha: string;
  readonly parents: readonly string[];
  /** Committer date, ISO 8601. */
  readonly at: string;
  readonly subject: string;
  readonly message: string;
  /** Release tags (`vMAJOR.MINOR.PATCH`) on this commit. */
  readonly tags: readonly string[];
  /** Changes against the first parent; empty for a root merge or an empty commit. */
  readonly changes: readonly Change[];
}

export interface History {
  /** Newest first, parents after children. */
  readonly commits: readonly Commit[];
  readonly main: string | null;
  readonly originMain: string | null;
}

const RECORD = "\x1e";
const FIELD = "\x1f";
const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

function parseChanges(text: string): Change[] {
  const changes: Change[] = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    const [status = "", first = "", second] = line.split("\t");
    const kind = status.charAt(0);
    if (second !== undefined && (kind === "R" || kind === "C")) {
      changes.push({ from: first, path: second, status: kind });
    } else if (first !== "") {
      changes.push({ path: first, status: kind });
    }
  }
  return changes;
}

/**
 * Every commit reachable from local `main` or `origin/main`, with its changes against the first
 * parent, rename detection and release-tag decorations: one `git log`. `origin/main` is matched by
 * a glob so that a repository without it still reads.
 */
export function readHistory(git: GitRunner, repository: string): History {
  const output = git(repository, [
    "log",
    "--topo-order",
    "--no-color",
    "--decorate=full",
    "--decorate-refs=refs/tags/",
    "--decorate-refs=refs/heads/main",
    "--decorate-refs=refs/remotes/origin/main",
    "--diff-merges=first-parent",
    "--name-status",
    "-M",
    `--format=${RECORD}%H${FIELD}%P${FIELD}%cI${FIELD}%D${FIELD}%B${FIELD}`,
    "refs/heads/main",
    // A bracket keeps the glob from implying a trailing /*; an absent ref matches nothing.
    "--glob=refs/remotes/origin/mai[n]",
    "--",
  ]);
  let main: string | null = null;
  let originMain: string | null = null;
  const commits: Commit[] = [];
  for (const record of output.split(RECORD)) {
    if (record.trim() === "") {
      continue;
    }
    const [sha = "", parents = "", at = "", decorations = "", message = "", rest = ""] =
      record.split(FIELD);
    const tags: string[] = [];
    for (const raw of decorations.split(", ")) {
      const ref = raw.replace(/^HEAD -> /, "").trim();
      if (ref === "refs/heads/main") {
        main = sha;
      } else if (ref === "refs/remotes/origin/main") {
        originMain = sha;
      } else if (ref.startsWith("tag: refs/tags/")) {
        const tag = ref.slice("tag: refs/tags/".length);
        if (RELEASE_TAG.test(tag)) {
          tags.push(tag);
        }
      }
    }
    commits.push({
      at,
      changes: parseChanges(rest),
      message: message.trim(),
      parents: parents === "" ? [] : parents.split(" "),
      sha,
      subject: message.split("\n")[0]?.trim() ?? "",
      tags,
    });
  }
  return { commits, main, originMain };
}

interface MainFile {
  readonly path: string;
  readonly text: string;
  /** The newest first-parent commit on `main` that changed the file. */
  readonly commit: string;
  readonly at: string;
}

export interface CommitRef {
  readonly sha: string;
  readonly at: string;
}

export interface MainFiles {
  readonly files: ReadonlyMap<string, MainFile>;
  /** The latest first-parent status transition for each current path. */
  readonly statusAt: ReadonlyMap<string, CommitRef>;
  /**
   * The oldest first-parent commit on `main` whose change sets each file's front-matter `status`
   * to `done`: added as `done`, or changed from another status.
   */
  readonly doneAt: ReadonlyMap<string, CommitRef>;
}

/** The front-matter `status` value of a work file's text, or null. */
function frontMatterStatus(lines: readonly string[]): string | null {
  if (lines[0] !== "---") {
    return null;
  }
  for (const line of lines.slice(1)) {
    if (line === "---") {
      return null;
    }
    const match = /^status:\s*(.*?)\s*$/.exec(line);
    if (match !== null) {
      return match[1] ?? null;
    }
  }
  return null;
}

/**
 * Every file under `directory` on `main`, from one first-parent `git log -p` with unbounded
 * context: each diff holds the whole old and new text, so the newest diff of a path gives its
 * current text (a path whose newest diff deletes it is absent) and each diff shows whether it set
 * the front-matter status to `done`.
 */
export function readMainFiles(git: GitRunner, repository: string, directory: string): MainFiles {
  const output = git(repository, [
    "log",
    "--first-parent",
    "--diff-merges=first-parent",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--unified=100000000",
    "-p",
    `--format=${RECORD}%H${FIELD}%cI${FIELD}`,
    "refs/heads/main",
    "--",
    `${directory}/`,
  ]);
  const files = new Map<string, MainFile>();
  const statusAt = new Map<string, CommitRef>();
  const doneAt = new Map<string, CommitRef>();
  /** Paths whose current state is known: deleted, or text taken from their newest content diff. */
  const settled = new Set<string>();
  const latest = new Map<string, { commit: string; at: string }>();
  for (const record of output.split(RECORD)) {
    if (record.trim() === "") {
      continue;
    }
    const [commit = "", at = "", body = ""] = record.split(FIELD);
    for (const section of body.split(/^diff --git /m).slice(1)) {
      const lines = section.split("\n");
      const target = lines.find((line) => line.startsWith("+++ "));
      const source = lines.find((line) => line.startsWith("--- "));
      const header = /^a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
      const path =
        target !== undefined && target !== "+++ /dev/null"
          ? target.slice("+++ b/".length)
          : source !== undefined && source !== "--- /dev/null"
            ? source.slice("--- a/".length)
            : (header?.[2] ?? "");
      if (path === "") {
        continue;
      }
      if (!latest.has(path)) {
        latest.set(path, { at, commit });
      }
      const deleted =
        target === "+++ /dev/null" || lines.some((line) => line.startsWith("deleted file mode"));
      const hunk = lines.findIndex((line) => line.startsWith("@@"));
      if (deleted || hunk < 0) {
        // A deletion, a mode change or an empty file sets no status.
        if (!settled.has(path) && (deleted || lines.some((l) => l.startsWith("new file mode")))) {
          settled.add(path);
          if (!deleted) {
            files.set(path, { ...latest.get(path)!, path, text: "" });
          }
        }
        continue;
      }
      const content = lines.slice(hunk + 1);
      const after = content.filter((line) => line.startsWith(" ") || line.startsWith("+"));
      const before = content.filter((line) => line.startsWith(" ") || line.startsWith("-"));
      const created = source === "--- /dev/null";
      const was = created ? null : frontMatterStatus(before.map((line) => line.slice(1)));
      const now = frontMatterStatus(after.map((line) => line.slice(1)));
      if (now !== was && !statusAt.has(path)) {
        statusAt.set(path, { at, sha: commit });
      }
      if (now === "done" && was !== "done") {
        // Newest first: the last assignment is the oldest such commit.
        doneAt.set(path, { at, sha: commit });
      }
      if (!settled.has(path)) {
        settled.add(path);
        files.set(path, {
          ...latest.get(path)!,
          path,
          text: `${after.map((line) => line.slice(1)).join("\n")}\n`,
        });
      }
    }
  }
  return { doneAt, files, statusAt };
}
