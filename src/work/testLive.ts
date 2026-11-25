// Scratch coordinator, kit and game repositories with a registry for the work verb, graph and
// import tests. Synthetic IDs only.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { systemGit } from "../core/git.ts";
import type { Io } from "../core/io.ts";
import { loadLayout } from "../core/layout.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import type { LiveContext } from "./live.ts";

export const GAME = "sample-game";
export const KIT = "sample-kit";
export const IDS = {
  art: "00000000-0000-4000-8000-0000000000a2",
  coordinator: "00000000-0000-4000-8000-0000000000a0",
  kit: "00000000-0000-4000-8000-0000000000a1",
  tech: "00000000-0000-4000-8000-0000000000a3",
} as const;
export const ROLES = {
  art: `${GAME}/art`,
  coordinator: "game-coordinator",
  kit: KIT,
  tech: `${GAME}/tech`,
} as const;

let clock = Date.parse("2026-11-01T00:00:00Z");

function gitEnv(): NodeJS.ProcessEnv {
  const at = new Date(clock).toISOString();
  clock += 60_000;
  return {
    GIT_AUTHOR_DATE: at,
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_COMMITTER_DATE: at,
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: tmpdir(),
    PATH: process.env.PATH,
  };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
}

/** Write (or delete, for null) each file, then commit everything; returns the new SHA. */
export function commit(
  repo: string,
  message: string,
  files: Record<string, string | null>,
): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      rmSync(join(repo, path));
    } else {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

interface WorkFileOptions {
  readonly design?: string;
  readonly owner?: string;
  readonly supersedes?: string | readonly string[];
  readonly related?: readonly string[];
  readonly decisions?: readonly string[];
  readonly approved?: string;
}

function listField(value: string | readonly string[]): string {
  return typeof value === "string" ? value : `[${value.join(", ")}]`;
}

export function workFile(
  id: string,
  title: string,
  status: string,
  options: WorkFileOptions = {},
): string {
  return [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    `status: ${status}`,
    `approved: ${options.approved ?? "user, 2026-11-01"}`,
    `design: ${options.design ?? "tech"}`,
    ...(options.owner === undefined ? [] : [`owner: ${options.owner}`]),
    ...(options.related === undefined ? [] : [`related: [${options.related.join(", ")}]`]),
    ...(options.supersedes === undefined ? [] : [`supersedes: ${listField(options.supersedes)}`]),
    "---",
    "",
    "## Scope",
    "",
    "Fixture.",
    "",
    "## Decisions",
    "",
    ...(options.decisions ?? ["None yet."]),
    "",
  ].join("\n");
}

interface LiveFixture {
  readonly base: string;
  readonly root: string;
  readonly kit: string;
  readonly game: string;
}

/**
 * game-coordinator, one kit and one game. The kit is owned by `sample-kit`; the game by its art
 * and tech roles. Each repository starts with the given work files on `main`.
 */
export function liveFixture(
  files: {
    readonly kit?: Record<string, string>;
    readonly game?: Record<string, string>;
    readonly coordinator?: Record<string, string>;
  } = {},
): LiveFixture {
  const base = mkdtempSync(join(tmpdir(), "work-live-"));
  const root = join(base, "game-coordinator");
  const kit = join(base, KIT);
  const game = join(base, GAME);
  for (const repo of [root, kit, game]) {
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
  }
  commit(root, "Start the coordinator", {
    ".gitignore": "var/\n",
    "config.json": `${JSON.stringify({
      games: { [GAME]: { name: "Sample", path: `../${GAME}`, roles: ["art", "tech"] } },
      kits: { [KIT]: { path: `../${KIT}` } },
      schema: 1,
      sharedRoles: ["game-coordinator", KIT],
      timezone: "America/Toronto",
      wakeMinutes: [],
    })}\n`,
    ...prefixed(files.coordinator),
  });
  commit(kit, "Start the kit", { "README.md": "Kit\n", ...prefixed(files.kit) });
  commit(game, "Start the game", { "README.md": "Game\n", ...prefixed(files.game) });
  createRegistry(loadLayout(root), {
    harness: "claude",
    host: { nativeProjectId: "project-1", root: "." },
    operations: {},
    roles: {
      [ROLES.art]: {
        conversations: { claude: IDS.art },
        ownership: "active",
        worktree: `../${GAME}`,
      },
      [ROLES.coordinator]: {
        conversations: { claude: IDS.coordinator },
        ownership: "active",
        worktree: ".",
      },
      [ROLES.kit]: {
        conversations: { claude: IDS.kit },
        ownership: "active",
        worktree: `../${KIT}`,
      },
      [ROLES.tech]: {
        conversations: { claude: IDS.tech },
        ownership: "active",
        worktree: `../${GAME}`,
      },
    },
    schema: 1,
    transfers: [],
  } as unknown as Omit<Registry, "revision" | "updatedAt">);
  return { base, game, kit, root };
}

function prefixed(files: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files ?? {}).map(([id, text]) => [`docs/work/${id}.md`, text]),
  );
}

/** A live context whose caller is `nativeId` (none when omitted). */
export function live(fixture: LiveFixture, nativeId?: string): LiveContext {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    ...(nativeId === undefined ? {} : { CLAUDE_CODE_SESSION_ID: nativeId }),
  };
  return { coordinatorRoot: fixture.root, env, git: systemGit(env) };
}

/** An Io for `main` with the coordinator in the environment. */
export function liveIo(
  fixture: LiveFixture,
  cwd: string,
  nativeId?: string,
): Io & { output: () => { out: string; err: string } } {
  let out = "";
  let err = "";
  return {
    cwd,
    env: {
      COORDINATION_KIT_ROOT: fixture.root,
      PATH: process.env.PATH,
      ...(nativeId === undefined ? {} : { CLAUDE_CODE_SESSION_ID: nativeId }),
    },
    err: (text) => {
      err += text;
    },
    out: (text) => {
      out += text;
    },
    output: () => ({ err, out }),
  };
}
