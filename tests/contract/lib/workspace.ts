// Scratch workspace for every contract case: a game-coordinator root, one or more game
// checkouts, scratch HOME and XDG state, and fake external tools on PATH.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const KIT_ROOT = join(HERE, "..", "..", "..");
const FAKE_TOOLS = ["claude", "docker", "gh", "git", "wrangler"] as const;
export type FakeTool = (typeof FAKE_TOOLS)[number];

/** The committed game `delivery-kit.json` (plan schema 1). Values are passed through as given. */
export interface GameConfig {
  schema?: unknown;
  git?: { main?: unknown; remote?: unknown; github?: unknown };
  schedule?: { departures?: unknown; timezone?: unknown };
  gate?: { image?: unknown; install?: unknown; steps?: unknown };
  resources?: { cpus?: unknown; loadLimit?: unknown; memoryMiB?: unknown };
  ci?: { requiredNames?: unknown; pollSeconds?: unknown; timeoutSeconds?: unknown };
  deploy?: { mode?: unknown; skipPattern?: unknown };
  reports?: {
    project?: unknown;
    scheduledTicks?: unknown;
    recipient?: unknown;
    workerParents?: unknown;
  };
}

export interface RoleRecord {
  ownership?: string;
  conversations: { claude?: string | null; codex?: string | null };
  [key: string]: unknown;
}

export interface Registry {
  schema: 1;
  revision: number;
  harness: "claude" | "codex";
  roles: Record<string, RoleRecord>;
  [key: string]: unknown;
}

export interface GameOptions {
  /** Key in game-coordinator `config.json`; the checkout is created beside game-coordinator. */
  game?: string;
  config?: GameConfig;
}

function defaultConfig(): GameConfig {
  return {
    schema: 1,
    git: { main: "main", remote: "origin", github: "" },
    schedule: { departures: ["00", "20", "40"], timezone: "America/Toronto" },
    gate: {
      image: "unused",
      install: "npm ci",
      steps: [
        { name: "check", run: "check" },
        { name: "lint", run: "lint" },
        { name: "test", run: "test" },
        { name: "build", run: "build" },
      ],
    },
    resources: { cpus: 4, loadLimit: 24, memoryMiB: 4096 },
    ci: { requiredNames: ["Test"] },
    deploy: { mode: "wrangler", skipPattern: "(\\.md$|^art/|^gameplay/)" },
    reports: {},
  };
}

/** The fake tools' behaviour; only `claude agents --json` is modelled. */
export interface Control {
  claude?: { exitCode?: number; agents?: unknown };
}

export interface Call {
  tool: FakeTool;
  args: string[];
  cwd: string;
}

export class Workspace {
  readonly root: string;
  readonly home: string;
  readonly xdgState: string;
  readonly coordinator: string;
  readonly fakeDir: string;
  readonly fakeBin: string;
  readonly game: string;
  readonly repo: string;
  readonly state: string;
  config: GameConfig;
  /** Extra environment for every CLI invocation (adapter overrides such as CODEX_CONTROL_SOCKET). */
  env: Record<string, string> = {};

  constructor(options: GameOptions = {}) {
    // Short paths keep Unix socket names under the 108-byte limit.
    this.root = mkdtempSync(join(tmpdir(), "dk-"));
    this.home = join(this.root, "home");
    this.xdgState = join(this.home, ".local", "state");
    this.coordinator = join(this.root, "game-coordinator");
    this.fakeDir = join(this.root, "fakes");
    this.fakeBin = join(this.fakeDir, "bin");
    this.game = options.game ?? "fixture-game";
    this.repo = join(this.root, this.game);
    this.state = join(this.coordinator, "var", "games", this.game, "bus");
    this.config = options.config ?? defaultConfig();
    for (const path of [this.xdgState, this.fakeBin, this.repo, this.state])
      mkdirSync(path, { recursive: true });
    this.installFakes();
    this.setControl({});
    this.writeCoordinator();
    this.writeDeliveryControl();
  }

  private installFakes(): void {
    const script = join(HERE, "fake-tool.mjs");
    for (const tool of FAKE_TOOLS) {
      const path = join(this.fakeBin, tool);
      writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${script}' ${tool} "$@"\n`);
      chmodSync(path, 0o755);
    }
  }

  private writeCoordinator(): void {
    execFileSync("git", ["init", "--quiet", this.coordinator], {
      env: { HOME: this.home, PATH: process.env.PATH },
    });
    writeFileSync(join(this.coordinator, ".gitignore"), "/var/\n");
    writeJson(join(this.coordinator, "config.json"), {
      schema: 1,
      timezone: "America/Toronto",
      wakeMinutes: [20, 50],
      games: {
        [this.game]: {
          name: "Fixture",
          path: `../${this.game}`,
          roles: ["art", "gameplay", "tech"],
        },
      },
      kits: {},
      sharedRoles: ["game-coordinator", "art-kit", "delivery-kit", "game-kit"],
    });
    this.writeRegistry({ schema: 1, revision: 1, harness: "claude", roles: {} });
  }

  /** Update game-coordinator `config.json` fields (for example `wakeMinutes`). */
  updateCoordinatorConfig(change: Record<string, unknown>): void {
    const path = join(this.coordinator, "config.json");
    writeJson(path, { ...JSON.parse(readFileSync(path, "utf8")), ...change });
  }

  coordinatorConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(this.coordinator, "config.json"), "utf8"));
  }

  /**
   * Write var/registry.json, completing the 1.0 schema fields a case leaves out. Role keys
   * without a game prefix are registered as shared roles in config.json, as the skills do.
   */
  writeRegistry(registry: Registry): void {
    const roles = Object.fromEntries(
      Object.entries(registry.roles).map(([key, role]) => [
        key,
        { ownership: "active", worktree: ".", ...role },
      ]),
    );
    const complete = {
      updatedAt: "2026-11-04T03:00:00Z",
      host: { nativeProjectId: "fixture-project", root: "." },
      operations: {},
      transfers: [],
      ...registry,
      roles,
    };
    writeJson(join(this.coordinator, "var", "registry.json"), complete);
    const config = this.coordinatorConfig();
    const shared = new Set(config.sharedRoles as string[]);
    for (const key of Object.keys(roles)) if (!key.includes("/")) shared.add(key);
    writeJson(join(this.coordinator, "config.json"), { ...config, sharedRoles: [...shared] });
  }

  registry(): Registry {
    return JSON.parse(readFileSync(join(this.coordinator, "var", "registry.json"), "utf8"));
  }

  get routeFile(): string {
    return join(this.coordinator, "var", "route.json");
  }

  /** Write var/route.json: a schema 1 role-name route, or raw text for a malformed one. */
  writeRoute(route: unknown): void {
    writeFileSync(this.routeFile, typeof route === "string" ? route : JSON.stringify(route));
  }

  get configFile(): string {
    return join(this.repo, "delivery-kit.json");
  }

  /** delivery-kit's control record, which coordination commands must leave unchanged. */
  private writeDeliveryControl(): void {
    const updatedAt = "2026-11-09T20:00:00.000Z";
    this.write(
      "delivery-control.json",
      JSON.stringify({
        schema: 1,
        revision: 1,
        desired: {
          state: "enabled",
          reason: "fixture adoption",
          requester: "game-coordinator",
          updatedAt,
          revision: 1,
        },
        observed: null,
        activities: {},
      }),
    );
  }

  private setControl(control: Control): void {
    writeJson(join(this.fakeDir, "control.json"), control);
  }

  updateControl(change: (control: Control) => void): void {
    const control = this.control();
    change(control);
    this.setControl(control);
  }

  private control(): Control {
    return JSON.parse(readFileSync(join(this.fakeDir, "control.json"), "utf8"));
  }

  calls(tool?: FakeTool): Call[] {
    const path = join(this.fakeDir, "calls.jsonl");
    if (!existsSync(path)) return [];
    const rows = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call);
    return tool ? rows.filter((row) => row.tool === tool) : rows;
  }

  /** Base environment: scratch HOME and XDG state, fakes first on PATH. */
  baseEnv(): Record<string, string> {
    const env: Record<string, string> = {
      PATH: `${this.fakeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      HOME: this.home,
      XDG_STATE_HOME: this.xdgState,
      DK_FAKE_DIR: this.fakeDir,
      LANG: "C.UTF-8",
      NODE_OPTIONS: "--no-experimental-sqlite",
    };
    return { ...env, ...this.env };
  }

  // State helpers. Paths are relative to the game's bus state directory.
  path(...parts: string[]): string {
    return join(this.state, ...parts);
  }

  read(...parts: string[]): string {
    return readFileSync(this.path(...parts), "utf8");
  }

  readJson<T = Record<string, unknown>>(...parts: string[]): T {
    return JSON.parse(this.read(...parts)) as T;
  }

  exists(...parts: string[]): boolean {
    return existsSync(this.path(...parts));
  }

  write(name: string, content: string): void {
    mkdirSync(dirname(this.path(name)), { recursive: true });
    writeFileSync(this.path(name), content);
  }

  list(...parts: string[]): string[] {
    const path = this.path(...parts);
    return existsSync(path) ? readdirSync(path).sort() : [];
  }

  /** Outbox events, oldest first. */
  events(): Array<Record<string, unknown>> {
    return this.list("events")
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.readJson(join("events", name)))
      .sort((a, b) => Number(a.created) - Number(b.created));
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
