import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readJson } from "../core/durable.ts";
import { systemGit } from "../core/git.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler } from "../core/io.ts";
import { loadLayout } from "../core/layout.ts";
import { validateStandaloneConfig } from "../core/standalone.ts";
import { stateRoot } from "../core/stateRoot.ts";
import { readRegistry } from "../registry/store.ts";
import { init, projectRegister } from "./init.ts";

const MAINTAINER = "00000000-0000-4000-8000-000000000001";
const REVIEWER = "00000000-0000-4000-8000-000000000002";
const git = systemGit({});

function fixture(initGit = true): string {
  const root = mkdtempSync(join(tmpdir(), "standalone-project-"));
  if (initGit) {
    git(root, ["init", "-q", "-b", "main"]);
  }
  return root;
}

async function run(handler: Handler, root: string, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await handler(
    { cwd: root, env: {}, err: (line) => (err += line), out: (line) => (out += line) },
    root,
    args,
  );
  return { code, err, json: out === "" ? null : (JSON.parse(out) as unknown) };
}

describe("standalone init", () => {
  it("scaffolds scoped Git files, leaves unrelated config and state intact and repeats unchanged", async () => {
    const root = fixture();
    const unrelated = join(root, "config.json");
    const varDir = join(root, "var");
    const ignore = join(root, ".gitignore");
    writeFileSync(unrelated, '{"unrelated":true}\n');
    mkdirSync(varDir);
    writeFileSync(join(varDir, "fixture"), "untouched");
    writeFileSync(ignore, "unrelated-pattern");

    const args = ["--project", "sample-project", "--role", "maintainer", "--role", "reviewer"];
    expect(await run(init, root, ...args)).toMatchObject({
      code: EXIT_OK,
      json: {
        duplicate: false,
        project: "sample-project",
        revision: 1,
        roles: ["maintainer", "reviewer"],
      },
    });
    expect(readFileSync(ignore, "utf8")).toBe("unrelated-pattern\n/.coordination-kit/\n");
    expect(readFileSync(unrelated, "utf8")).toBe('{"unrelated":true}\n');
    expect(readFileSync(join(varDir, "fixture"), "utf8")).toBe("untouched");
    const layout = loadLayout(root);
    expect(layout).toMatchObject({
      config: { games: {}, kits: {}, sharedRoles: ["maintainer", "reviewer"], wakeMinutes: [] },
      configFile: join(root, "coordination-kit.json"),
      project: {
        project: { id: "sample-project", roles: ["maintainer", "reviewer"] },
        review: "off",
        schema: 1,
      },
      varDir: join(root, ".coordination-kit"),
    });
    expect(stateRoot(layout)).toBe(layout.varDir);
    expect(readRegistry(layout)).toMatchObject({
      roles: {
        maintainer: { conversations: {}, worktree: "." },
        reviewer: { conversations: {}, worktree: "." },
      },
    });
    expect(git(root, ["check-ignore", "--", ".coordination-kit/registry.json"])).toContain(
      ".coordination-kit/registry.json",
    );
    expect(git(root, ["ls-files", "--", "coordination-kit.json"])).toBe("");
    const before = [layout.configFile, layout.registryFile, ignore].map((path) =>
      readFileSync(path),
    );
    expect(await run(init, root, "--project", "sample-project")).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: true, revision: 1 },
    });
    expect(await run(init, root, "--project", "different")).toMatchObject({ code: EXIT_INVALID });
    expect(
      [layout.configFile, layout.registryFile, ignore].map((path) => readFileSync(path)),
    ).toEqual(before);
  });

  it("creates a default role, stores provider options and keeps the new config visible to Git", async () => {
    const root = fixture();
    writeFileSync(join(root, ".gitignore"), "*.json\n");
    expect(
      await run(
        init,
        root,
        "--project",
        "sample",
        "--review",
        "pr",
        "--provider",
        "gitlab",
        "--repository",
        "group/subgroup/repo",
      ),
    ).toMatchObject({ code: EXIT_OK, json: { roles: ["maintainer"] } });
    const config = readJson(join(root, "coordination-kit.json"));
    expect(config).toMatchObject({
      integration: { provider: "gitlab", repository: "group/subgroup/repo" },
      project: { id: "sample", roles: ["maintainer"] },
      review: "pr",
    });
    expect(git(root, ["status", "--porcelain"])).toContain("?? coordination-kit.json");
    expect(git(root, ["status", "--porcelain"])).not.toContain(".coordination-kit/");
  });

  it("rejects invalid input and existing managed or symlinked state before overwriting", async () => {
    const root = fixture();
    expect(await run(init, root, "--project", "sample", "--provider", "github")).toMatchObject({
      code: EXIT_USAGE,
    });
    expect(existsSync(join(root, ".coordination-kit"))).toBe(false);
    expect(await run(init, fixture(false), "--project", "sample")).toMatchObject({
      code: EXIT_INVALID,
    });
    const target = fixture();
    symlinkSync(target, join(root, ".coordination-kit"), "dir");
    expect(await run(init, root, "--project", "sample")).toMatchObject({ code: EXIT_INVALID });
    expect(existsSync(join(target, "registry.json"))).toBe(false);
    expect(existsSync(join(root, "coordination-kit.json"))).toBe(false);

    const managed = fixture();
    writeFileSync(join(managed, "config.json"), "{}");
    mkdirSync(join(managed, "var"));
    writeFileSync(join(managed, "var", "registry.json"), "{}");
    expect(await run(init, managed, "--project", "sample")).toMatchObject({
      code: EXIT_INVALID,
      err: expect.stringContaining("already has a game-coordinator layout"),
    });
    expect(existsSync(join(managed, ".coordination-kit"))).toBe(false);
  });

  it("preserves a pending initial configuration and refuses independently tracked runtime paths", async () => {
    const root = fixture();
    const configPath = join(root, "coordination-kit.json");
    const config = '{"schema":1,"project":{"id":"sample","roles":["maintainer"]},"review":"off"}';
    writeFileSync(configPath, config);
    expect(await run(init, root, "--project", "other")).toMatchObject({ code: EXIT_INVALID });
    expect(existsSync(join(root, ".coordination-kit"))).toBe(false);
    expect(await run(init, root, "--project", "sample")).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: false, revision: 1 },
    });
    expect(readFileSync(configPath, "utf8")).toBe(config);

    const tracked = fixture();
    mkdirSync(join(tracked, ".coordination-kit"));
    writeFileSync(join(tracked, ".coordination-kit", "fixture"), "tracked");
    git(tracked, ["add", "--", ".coordination-kit/fixture"]);
    expect(await run(init, tracked, "--project", "sample")).toMatchObject({
      code: EXIT_INVALID,
      err: expect.stringContaining("already contains tracked files"),
    });
  });

  it("validates optional forge, branch and remote settings", () => {
    const minimum = { project: { id: "project", roles: ["maintainer"] }, review: "pr", schema: 1 };
    expect(
      validateStandaloneConfig({
        ...minimum,
        defaultBranch: "release/trunk",
        integration: {
          hostname: "gitlab.example.invalid",
          provider: "gitlab",
          repository: "group/subgroup/repo",
          requiredChecks: ["CI / unit"],
        },
        remote: "upstream",
      }),
    ).toMatchObject({ defaultBranch: "release/trunk", remote: "upstream" });
    for (const patch of [
      { defaultBranch: "release/../trunk" },
      { remote: "-fetch" },
      { integration: { provider: "github", repository: "group/subgroup/repo" } },
      {
        integration: {
          hostname: "https://gitlab.example.invalid",
          provider: "gitlab",
          repository: "a/b",
        },
      },
    ]) {
      expect(() => validateStandaloneConfig({ ...minimum, ...patch })).toThrow(
        "coordination-kit.json is invalid",
      );
    }
  });
});

describe("standalone project register", () => {
  it("records exact revisions and prevents replacing or duplicating bindings", async () => {
    const root = fixture();
    await run(init, root, "--project", "sample", "--role", "maintainer", "--role", "reviewer");
    const maintainer = ["--role", "maintainer", "--harness", "codex", "--native-id", MAINTAINER];
    expect(
      await run(projectRegister, root, ...maintainer, "--native-project-id", "session-project"),
    ).toMatchObject({ code: EXIT_OK, json: { duplicate: false, revision: 2, worktree: "." } });
    expect(await run(projectRegister, root, ...maintainer)).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: true, revision: 2 },
    });
    const reviewer = ["--role", "reviewer", "--harness", "claude", "--native-id"];
    expect(await run(projectRegister, root, ...reviewer, MAINTAINER)).toMatchObject({
      code: EXIT_INVALID,
      err: expect.stringContaining("already bound to another role"),
    });
    expect(
      await run(projectRegister, root, ...reviewer, REVIEWER, "--native-project-id", "unrelated"),
    ).toMatchObject({ code: EXIT_INVALID, err: expect.stringContaining("already in use") });
    expect(await run(projectRegister, root, ...reviewer, REVIEWER)).toMatchObject({
      code: EXIT_OK,
      json: { revision: 3 },
    });
    expect(
      await run(
        projectRegister,
        root,
        "--role",
        "maintainer",
        "--harness",
        "claude",
        "--native-id",
        MAINTAINER,
      ),
    ).toMatchObject({ code: EXIT_INVALID });
    expect(readRegistry(loadLayout(root))).toMatchObject({
      host: { nativeProjectId: "session-project" },
      revision: 3,
      roles: {
        maintainer: { conversations: { codex: MAINTAINER }, harness: "codex" },
        reviewer: { conversations: { claude: REVIEWER }, harness: "claude" },
      },
    });
  });

  it("accepts an in-repository linked checkout and rejects an unrelated or nested target", async () => {
    const root = fixture();
    git(root, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "Start the project",
    ]);
    await run(init, root, "--project", "sample");
    const path = join(root, "linked");
    git(root, ["worktree", "add", "-qb", "worker", path]);
    const args = ["--role", "maintainer", "--harness", "codex", "--native-id", MAINTAINER];
    mkdirSync(join(path, "nested"));
    expect(await run(projectRegister, root, ...args, "--worktree", "linked/nested")).toMatchObject({
      code: EXIT_INVALID,
    });
    expect(await run(projectRegister, root, ...args, "--worktree", fixture())).toMatchObject({
      code: EXIT_USAGE,
    });
    expect(await run(projectRegister, root, ...args, "--worktree", "linked")).toMatchObject({
      code: EXIT_OK,
      json: { worktree: "linked" },
    });
    expect(await run(init, path, "--project", "sample")).toMatchObject({ code: EXIT_INVALID });
  });
});
