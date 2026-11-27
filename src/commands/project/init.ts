import {
  appendFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../../core/cli/io.ts";
import {
  CONFIG_FILE,
  loadLayout,
  validateWorkspaceConfig,
} from "../../core/configuration/layout.ts";
import {
  STANDALONE_CONFIG_FILE,
  STANDALONE_STATE_DIR,
  type StandaloneConfig,
  validateStandaloneConfig,
} from "../../core/configuration/standalone.ts";
import {
  fsyncDirectory,
  JsonFileError,
  readJson,
  writeJsonDurable,
} from "../../core/files/durable.ts";
import { withLock } from "../../core/files/lock.ts";
import { type GitRunner, systemGit } from "../../core/git.ts";
import { CONVERSATION_ID_PATTERN, ValidationError } from "../../core/validate.ts";
import { type Harness, HARNESSES, type Registry } from "../../registry/schema.ts";
import { createRegistry, readRegistry, updateRegistry } from "../../registry/store.ts";
import { errorMessage, parseOptions, required, systemClock, Usage } from "../args.ts";
import { syncProjectSkills } from "../managedSkills.ts";

export const INIT_OPTIONS = {
  project: { type: "string" },
  provider: { type: "string" },
  repository: { type: "string" },
  review: { type: "string" },
  role: { multiple: true, type: "string" },
} as const;

export const PROJECT_REGISTER_OPTIONS = {
  harness: { type: "string" },
  "native-id": { type: "string" },
  "native-project-id": { type: "string" },
  role: { type: "string" },
  worktree: { type: "string" },
} as const;

const NATIVE_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function refuse(io: Io, error: unknown): number {
  io.err(`coordination-kit: ${errorMessage(error)}\n`);
  return error instanceof Usage ? EXIT_USAGE : EXIT_INVALID;
}

/** The primary checkout anchors the runtime state, including for registered linked worktrees. */
export function projectRoot(git: GitRunner, root: string): string {
  const canonical = realpathSync(root);
  const [top, gitDir, common] = git(canonical, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ])
    .trimEnd()
    .split("\n");
  if (realpathSync(top!) !== canonical || realpathSync(gitDir!) !== realpathSync(common!)) {
    throw new Error("standalone commands require the primary Git checkout as --root");
  }
  return canonical;
}

/** Mutating commands do not follow an existing symlink when inspecting their own file paths. */
function regularFile(path: string): boolean {
  try {
    if (!lstatSync(path).isFile()) {
      throw new Error(`${path}: expected a regular file`);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function stateDirectory(root: string): string {
  const path = join(root, STANDALONE_STATE_DIR);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  if (!lstatSync(path).isDirectory()) {
    throw new Error(`${path}: expected a directory`);
  }
  return path;
}

function isIgnored(git: GitRunner, root: string, path: string): boolean {
  try {
    git(root, ["check-ignore", "-q", "--", path]);
    return true;
  } catch {
    return false;
  }
}

function ignoreRuntime(git: GitRunner, root: string): void {
  const path = join(root, ".gitignore");
  const previous = regularFile(path) ? readFileSync(path, "utf8") : "";
  const rules = [];
  if (!isIgnored(git, root, `${STANDALONE_STATE_DIR}/`)) {
    rules.push(`/${STANDALONE_STATE_DIR}/`);
  }
  if (isIgnored(git, root, STANDALONE_CONFIG_FILE)) {
    rules.push(`!/${STANDALONE_CONFIG_FILE}`);
  }
  if (rules.length > 0) {
    const line = previous.includes("\r\n") ? "\r\n" : "\n";
    const prefix = previous === "" || previous.endsWith("\n") ? "" : line;
    appendFileSync(path, `${prefix}${rules.join(line)}${line}`, { mode: 0o644 });
  }
}

/** Publish a synced file exclusively. A conflicting entry is left untouched. */
function createConfig(path: string, root: string, varDir: string, value: StandaloneConfig): void {
  const temp = mkdtempSync(join(varDir, "init-"));
  try {
    const candidate = join(temp, STANDALONE_CONFIG_FILE);
    writeJsonDurable(candidate, value, { mode: 0o644 });
    linkSync(candidate, path);
    fsyncDirectory(root);
  } finally {
    rmSync(temp, { force: true, recursive: true });
  }
}

function seed(config: StandaloneConfig): Omit<Registry, "revision" | "updatedAt"> {
  return {
    harness: "codex",
    host: { nativeProjectId: config.project.id, root: "." },
    operations: {},
    roles: Object.fromEntries(
      config.project.roles.map((role) => [
        role,
        { conversations: {}, ownership: "active", worktree: "." },
      ]),
    ),
    schema: 1,
    transfers: [],
  };
}

function proposedConfig(args: string[]) {
  const { values } = parseOptions(INIT_OPTIONS, args);
  const project = required(values, "project");
  if ((values.provider === undefined) !== (values.repository === undefined)) {
    throw new Usage("--provider and --repository must be supplied together");
  }
  try {
    const config = validateStandaloneConfig({
      ...(values.provider === undefined
        ? {}
        : { integration: { provider: values.provider, repository: values.repository } }),
      project: { id: project, roles: values.role ?? ["maintainer"] },
      review: values.review ?? "off",
      schema: 1,
    });
    return { config, values };
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new Usage(error.message);
    }
    throw error;
  }
}

function sameInit(
  existing: StandaloneConfig,
  requested: ReturnType<typeof proposedConfig>,
): boolean {
  const { config, values } = requested;
  return (
    existing.project.id === config.project.id &&
    (values.role === undefined ||
      (existing.project.roles.length === config.project.roles.length &&
        existing.project.roles.every((role, index) => config.project.roles[index] === role))) &&
    (values.review === undefined || existing.review === config.review) &&
    (values.provider === undefined ||
      (existing.integration?.provider === config.integration?.provider &&
        existing.integration?.repository === config.integration?.repository))
  );
}

function existingConfig(
  path: string,
  requested: ReturnType<typeof proposedConfig>,
): StandaloneConfig | undefined {
  if (!regularFile(path)) {
    return undefined;
  }
  const config = validateStandaloneConfig(readJson(path));
  if (!sameInit(config, requested)) {
    throw new Error(`${STANDALONE_CONFIG_FILE} conflicts with the requested project settings`);
  }
  return config;
}

function matchesWorkspaceConfig(path: string): boolean {
  try {
    validateWorkspaceConfig(readJson(path));
    return true;
  } catch (error) {
    if (error instanceof ValidationError || error instanceof JsonFileError) {
      return false;
    }
    throw error;
  }
}

export const init: Handler = (io, root, args) => {
  try {
    const requested = proposedConfig(args);
    const git = systemGit(io.env);
    const repo = projectRoot(git, root);
    const configFile = join(repo, STANDALONE_CONFIG_FILE);
    const workspaceConfig = join(repo, CONFIG_FILE);
    if (
      existingConfig(configFile, requested) === undefined &&
      existsSync(workspaceConfig) &&
      (existsSync(join(repo, "var", "registry.json")) || matchesWorkspaceConfig(workspaceConfig))
    ) {
      throw new Error("this checkout already has a shared workspace layout");
    }
    if (git(repo, ["ls-files", "--", STANDALONE_STATE_DIR]) !== "") {
      throw new Error(`${STANDALONE_STATE_DIR}/ already contains tracked files`);
    }
    const varDir = stateDirectory(repo);
    const lock = join(varDir, "init.lock");
    regularFile(lock);
    return withLock(
      lock,
      () => {
        const existing = existingConfig(configFile, requested);
        const registryExists = regularFile(join(varDir, "registry.json"));
        regularFile(join(varDir, "registry.lock"));
        if (registryExists && existing === undefined) {
          throw new Error(
            `${STANDALONE_STATE_DIR}/registry.json exists without project configuration`,
          );
        }
        const current = registryExists ? readRegistry(loadLayout(repo)) : undefined;
        ignoreRuntime(git, repo);
        const project = existing ?? requested.config;
        if (existing === undefined) {
          createConfig(configFile, repo, varDir, project);
        }
        const layout = loadLayout(repo);
        const registry = current ?? createRegistry(systemClock, layout, seed(project));
        io.out(
          `${JSON.stringify({
            configFile,
            duplicate: existing !== undefined && registryExists,
            project: project.project.id,
            registryFile: layout.registryFile,
            revision: registry.revision,
            roles: project.project.roles,
            schema: 1,
          })}\n`,
        );
        return EXIT_OK;
      },
      { timeoutSeconds: 30 },
    );
  } catch (error) {
    return refuse(io, error);
  }
};

function qualifyWorktree(git: GitRunner, root: string, worktree: string): string {
  if (isAbsolute(worktree) || worktree.startsWith("~") || /[\0\r\n]/.test(worktree)) {
    throw new Usage("--worktree must be a Git worktree path relative to the project root");
  }
  const absolute = realpathSync(resolve(root, worktree));
  const [top, common] = git(absolute, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ])
    .trimEnd()
    .split("\n");
  const projectGit = git(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trimEnd();
  if (realpathSync(common!) !== realpathSync(projectGit) || realpathSync(top!) !== absolute) {
    throw new Error("the worktree must be a checkout root in this Git repository");
  }
  return relative(root, absolute) || ".";
}

function registered(
  registry: Registry,
  role: string,
  harness: Harness,
  nativeId: string,
  nativeProjectId: string,
  worktree: string,
): boolean {
  const record = registry.roles[role]!;
  if (Object.values(record.conversations).every((value) => value == null)) {
    return false;
  }
  if (
    record.conversations[harness] !== nativeId ||
    (record.harness ?? registry.harness) !== harness ||
    record.worktree !== worktree ||
    registry.host.nativeProjectId !== nativeProjectId
  ) {
    throw new Error(`${role}: a native binding already exists`);
  }
  return true;
}

async function syncRegisteredSkills(io: Io, checkout: string, harness: Harness) {
  try {
    return await syncProjectSkills(io, checkout, harness);
  } catch (error) {
    return { reason: errorMessage(error), status: "unavailable" as const };
  }
}

export const projectRegister: Handler = async (io, root, args) => {
  try {
    const { values } = parseOptions(PROJECT_REGISTER_OPTIONS, args);
    const role = required(values, "role");
    const harness = HARNESSES.find((value) => value === values.harness);
    const nativeId = required(values, "native-id");
    if (harness === undefined) {
      throw new Usage("--harness must be claude or codex");
    }
    if (!CONVERSATION_ID_PATTERN.test(nativeId)) {
      throw new Usage("--native-id must be a canonical conversation ID");
    }
    if (
      values["native-project-id"] !== undefined &&
      !NATIVE_PROJECT_ID.test(values["native-project-id"])
    ) {
      throw new Usage("--native-project-id must be a native project identifier");
    }
    const git = systemGit(io.env);
    const repo = projectRoot(git, root);
    if (!regularFile(join(repo, STANDALONE_CONFIG_FILE))) {
      throw new Error("run coordination-kit init in this project first");
    }
    const layout = loadLayout(repo);
    if (!lstatSync(layout.varDir).isDirectory()) {
      throw new Error(`${layout.varDir}: expected a directory`);
    }
    regularFile(layout.registryFile);
    regularFile(layout.registryLock);
    const current = readRegistry(layout);
    if (!layout.config.sharedRoles.includes(role)) {
      throw new Error(`${role}: is not a declared project role`);
    }
    const binding = Object.hasOwn(current.roles, role) ? current.roles[role] : undefined;
    const worktree = qualifyWorktree(git, repo, values.worktree ?? binding?.worktree ?? ".");
    const nativeProjectId = values["native-project-id"] ?? current.host.nativeProjectId;
    const duplicate =
      binding !== undefined &&
      registered(current, role, harness, nativeId, nativeProjectId, worktree);
    let registry = current;
    if (!duplicate) {
      const others = Object.entries(current.roles).filter(([name]) => name !== role);
      if (others.some(([, record]) => Object.values(record.conversations).includes(nativeId))) {
        throw new Error("that native conversation is already bound to another role");
      }
      if (
        nativeProjectId !== current.host.nativeProjectId &&
        others.some(([, record]) =>
          Object.values(record.conversations).some((value) => value != null),
        )
      ) {
        throw new Error("the native project identifier is already in use");
      }
      registry = updateRegistry(systemClock, layout, current.revision, (draft) => {
        draft.host.nativeProjectId = nativeProjectId;
        if (!Object.hasOwn(draft.roles, role)) {
          draft.roles[role] = { conversations: {}, ownership: "active", worktree };
        }
        const entry = draft.roles[role]!;
        entry.conversations[harness] = nativeId;
        entry.harness = harness;
        entry.worktree = worktree;
      });
    }
    const skillSync = await syncRegisteredSkills(io, repo, harness);
    if (skillSync.status !== "synced") {
      io.err(`coordination-kit: skills sync ${skillSync.status}. Review skillSync before retrying.\n`);
    }
    io.out(
      `${JSON.stringify({
        duplicate,
        harness,
        nativeId,
        revision: registry.revision,
        role,
        schema: 1,
        skillSync,
        worktree,
      })}\n`,
    );
    return EXIT_OK;
  } catch (error) {
    return refuse(io, error);
  }
};
