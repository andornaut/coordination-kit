import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler } from "../core/cli/io.ts";
import { systemGit } from "../core/git.ts";
import { errorMessage, parseOptions, required, Usage } from "./args.ts";
import { projectRoot } from "./project/init.ts";

export const SKILLS_INSTALL_OPTIONS = {
  harness: { type: "string" },
  scope: { type: "string" },
} as const;

const SKILLS = { status: "coordination-status", workflow: "coordination-kit-workflow" } as const;
const DIRECTORIES = { claude: ".claude", codex: ".agents" } as const;

function directory(parent: string, name: string): string {
  const path = join(parent, name);
  try {
    mkdirSync(path);
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

function existingSkillMatches(path: string, bytes: Buffer): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) {
    return false;
  }
  if (!entry.isFile() || !readFileSync(path).equals(bytes)) {
    throw new Error(`${path}: review the existing entry before installing the bundled skill`);
  }
  return true;
}

function install(directory: string, bytes: Buffer): boolean {
  const file = join(directory, "SKILL.md");
  if (existingSkillMatches(file, bytes)) {
    return false;
  }
  const scratch = mkdtempSync(join(directory, ".install-"));
  try {
    const candidate = join(scratch, "SKILL.md");
    writeFileSync(candidate, bytes, { mode: 0o644 });
    try {
      linkSync(candidate, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && existingSkillMatches(file, bytes)) {
        return false;
      }
      throw error;
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

export const skillsInstall: Handler = (io, root, args) => {
  try {
    const { positionals, values } = parseOptions(SKILLS_INSTALL_OPTIONS, args, 1);
    const [skill] = positionals;
    const harness = required(values, "harness");
    if (skill !== "workflow" && skill !== "status") {
      throw new Usage("choose the workflow or status skill");
    }
    if (harness !== "codex" && harness !== "claude") {
      throw new Usage("--harness must be codex or claude");
    }
    if (required(values, "scope") !== "project") {
      throw new Usage("--scope must be project");
    }
    const checkout = projectRoot(systemGit(io.env), root);
    const assets =
      io.entry === undefined
        ? fileURLToPath(new URL("../../skills", import.meta.url))
        : join(dirname(io.entry), "..", "skills");
    const name = SKILLS[skill];
    const bytes = readFileSync(join(assets, name, "SKILL.md"));
    const base = directory(checkout, DIRECTORIES[harness]);
    const target = directory(directory(base, "skills"), name);
    const installed = install(target, bytes);
    io.out(
      `${JSON.stringify({ installed, path: relative(checkout, join(target, "SKILL.md")) })}\n`,
    );
    return EXIT_OK;
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return error instanceof Usage ? EXIT_USAGE : EXIT_INVALID;
  }
};
