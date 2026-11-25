// Scratch game-coordinator trees for tests. Every fixture lives under a fresh temporary directory.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "./clock.ts";
import { type GitRunner, systemGit } from "./git.ts";

/** The instant every `TEST_CLOCK` reading returns. */
export const TEST_NOW = "2026-11-25T12:00:00.000Z";
/** A fixed clock, so no test reads the real time. */
export const TEST_CLOCK: Clock = () => new Date(TEST_NOW);
/** A clock fixed at `iso`. */
export function clockAt(iso: string): Clock {
  return () => new Date(iso);
}
/** Git over an empty environment: no caller configuration, the default executable path. */
export const TEST_GIT: GitRunner = systemGit({});
/** The host name tests pass where decision text must not contain this machine's name. */
export const TEST_HOST = "fixture-host";
/** The context tests open stores with: the fixed clock and an empty environment. */
export const TEST_CONTEXT = { clock: TEST_CLOCK, env: {} } as const;

export const CLAUDE_TECH = "00000000-0000-4000-8000-000000000001";
export const CODEX_TECH = "00000000-0000-4000-8000-000000000002";
export const CLAUDE_COORDINATOR = "00000000-0000-4000-8000-000000000003";

export function coordinatorConfig(): Record<string, unknown> {
  return {
    games: {
      "archies-dog-walks": {
        name: "Archie",
        path: "../archies-dog-walks",
        roles: ["art", "gameplay", "tech"],
      },
      "chibis-way-home": {
        name: "Chibi",
        path: "../chibis-way-home",
        roles: ["art", "gameplay", "tech"],
      },
    },
    kits: { "art-kit": { path: "../art-kit" }, "delivery-kit": { path: "../delivery-kit" } },
    schema: 1,
    sharedRoles: ["game-coordinator", "art-kit", "delivery-kit", "game-kit"],
    timezone: "America/Toronto",
    wakeMinutes: [20, 50],
  };
}

export function projectConfig(project: string): Record<string, unknown> {
  return {
    ci: { pollSeconds: 60, requiredNames: ["Lint", "Test"], timeoutSeconds: 1800 },
    deploy: { mode: "wrangler", skipPattern: "\\.md$" },
    gate: {
      image: "node:24.21.0",
      install: "npm ci",
      steps: [
        { name: "lint", run: "npm run lint" },
        { name: "test", run: "npm test -- --maxWorkers=4" },
      ],
    },
    git: { github: "owner/game", main: "main", remote: "origin" },
    reports: {
      project,
      recipient: "game-coordinator",
      scheduledTicks: true,
      workerParents: ["game-coordinator"],
    },
    resources: { cpus: 4, loadLimit: 24, memoryMiB: 4096 },
    schedule: { departures: ["00"], timezone: "America/Toronto" },
    schema: 1,
  };
}

export function registryInput(): Record<string, unknown> {
  return {
    harness: "claude",
    host: { nativeProjectId: "project-1", root: "." },
    operations: {
      "archies-dog-walks": { activation: { marker: "adopt-1" }, busOwner: "game-coordinator" },
    },
    roles: {
      "archies-dog-walks/tech": {
        activation: { checkpoint: "var/handoffs/tech.json", marker: "tech-1" },
        branch: "claude-tech",
        conversations: { claude: CLAUDE_TECH, codex: CODEX_TECH },
        ownership: "active",
        phase: "active",
        worktree: "../archies-dog-walks/.worktrees/tech",
      },
      "game-coordinator": {
        conversations: { claude: CLAUDE_COORDINATOR },
        ownership: "active",
        worktree: ".",
      },
    },
    schema: 1,
    transfers: [],
  };
}

interface Fixture {
  /** The game-coordinator root. */
  readonly root: string;
  readonly base: string;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A scratch tree: base/game-coordinator with config.json and base/<game>/delivery-kit.json per game. */
export function makeFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "coordination-kit-"));
  const root = join(base, "game-coordinator");
  mkdirSync(root);
  writeJson(join(root, "config.json"), coordinatorConfig());
  for (const [game, project] of [
    ["archies-dog-walks", "Archie"],
    ["chibis-way-home", "Chibi"],
  ] as const) {
    mkdirSync(join(base, game));
    writeJson(join(base, game, "delivery-kit.json"), projectConfig(project));
  }
  return { base, root };
}

export function writeFixtureJson(path: string, value: unknown): void {
  writeJson(path, value);
}

/**
 * An external state root for `layout`: a fresh directory outside every repository, named by
 * `var/work-protocol.json` in the 3.0 shape, or in the 2.1 shape with `legacy`.
 */
export function stateRootFixture(
  layout: { readonly varDir: string },
  options: { readonly legacy?: boolean } = {},
): string {
  const stateRoot = mkdtempSync(join(tmpdir(), "coordination-kit-state-"));
  mkdirSync(layout.varDir, { recursive: true });
  writeJson(
    join(layout.varDir, "work-protocol.json"),
    options.legacy === true
      ? { generation: 1, schema: 1, stateRoot, workspaceId: "fixture" }
      : { schema: 2, stateRoot },
  );
  return stateRoot;
}
