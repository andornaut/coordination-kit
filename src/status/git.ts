// Read-only Git access for `status`: repository resolution, one history pass over local `main` and
// `origin/main`, and one pass over the work files on `main`. Every call reads local refs and objects
// only; nothing fetches, checks out or writes.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

/** Runs one read-only git command in `cwd` and returns stdout; throws on a nonzero exit. */
export type GitRunner = (cwd: string, args: readonly string[]) => string;

export class GitError extends Error {
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
export function systemGit(env: NodeJS.ProcessEnv, onCall?: () => void): GitRunner {
  const environment = gitEnvironment(env);
  return (cwd, args) => {
    onCall?.();
    const result = spawnSync(
      "git",
      ["-c", "core.quotePath=false", "-c", "log.showSignature=false", ...args],
      { cwd, encoding: "utf8", env: environment, maxBuffer: 1024 * 1024 * 1024 },
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

export interface Change {
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

export interface MainFile {
  readonly path: string;
  readonly text: string;
  /** The newest first-parent commit on `main` that changed the file. */
  readonly commit: string;
  readonly at: string;
}

/**
 * The text of every file under `directory` on `main`, from one first-parent `git log -p` with
 * unbounded context: the newest diff of each path holds its whole current text. A path whose
 * newest diff deletes it is absent.
 */
export function readMainFiles(
  git: GitRunner,
  repository: string,
  directory: string,
): Map<string, MainFile> {
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
  /** Paths whose newest diff deletes them, or whose newest content diff is still to come. */
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
      if (path === "" || settled.has(path)) {
        continue;
      }
      if (!latest.has(path)) {
        latest.set(path, { at, commit });
      }
      if (
        target === "+++ /dev/null" ||
        lines.some((line) => line.startsWith("deleted file mode"))
      ) {
        settled.add(path);
        continue;
      }
      const hunk = lines.findIndex((line) => line.startsWith("@@"));
      if (hunk < 0) {
        // A mode change or an empty file: the content comes from an older diff, if any.
        if (lines.some((line) => line.startsWith("new file mode"))) {
          settled.add(path);
          files.set(path, { ...latest.get(path)!, path, text: "" });
        }
        continue;
      }
      const text = lines
        .slice(hunk + 1)
        .filter((line) => line.startsWith(" ") || line.startsWith("+"))
        .map((line) => line.slice(1));
      settled.add(path);
      files.set(path, { ...latest.get(path)!, path, text: `${text.join("\n")}\n` });
    }
  }
  return files;
}
