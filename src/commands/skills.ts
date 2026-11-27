import { join, relative } from "node:path";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler } from "../core/cli/io.ts";
import { systemGit } from "../core/git.ts";
import { errorMessage, parseOptions, required, Usage } from "./args.ts";
import {
  bundledSkill,
  installSkill,
  MANAGED_SKILLS,
  SKILL_DIRECTORIES,
  skillAdoptions,
  skillDirectory,
  syncManagedProjectSkills,
} from "./managedSkills.ts";
import { projectRoot } from "./project/init.ts";

export { syncProjectSkills } from "./managedSkills.ts";

export const SKILLS_INSTALL_OPTIONS = {
  harness: { type: "string" },
  scope: { type: "string" },
} as const;

export const SKILLS_SYNC_OPTIONS = {
  adopt: { multiple: true, type: "string" },
  ...SKILLS_INSTALL_OPTIONS,
} as const;

const SKILLS = new Map([["agent-cleanup", "agent-cleanup"], ...Object.entries(MANAGED_SKILLS)]);

export const skillsInstall: Handler = (io, root, args) => {
  try {
    const { positionals, values } = parseOptions(SKILLS_INSTALL_OPTIONS, args, 1);
    const name = SKILLS.get(positionals[0]!);
    const harness = required(values, "harness");
    if (name === undefined) {
      throw new Usage(`choose a bundled skill: ${[...SKILLS.keys()].join(", ")}`);
    }
    if (harness !== "codex" && harness !== "claude") {
      throw new Usage("--harness must be codex or claude");
    }
    if ((values.scope ?? "project") !== "project") {
      throw new Usage("--scope must be project");
    }
    const checkout = projectRoot(systemGit(io.env), root);
    const bytes = bundledSkill(io, name);
    const base = skillDirectory(checkout, SKILL_DIRECTORIES[harness]);
    const target = skillDirectory(skillDirectory(base, "skills"), name);
    const installed = installSkill(target, bytes);
    io.out(
      `${JSON.stringify({ installed, path: relative(checkout, join(target, "SKILL.md")) })}\n`,
    );
    return EXIT_OK;
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return error instanceof Usage ? EXIT_USAGE : EXIT_INVALID;
  }
};

export const skillsSync: Handler = (io, root, args) => {
  try {
    const { values } = parseOptions(SKILLS_SYNC_OPTIONS, args);
    const harness = required(values, "harness");
    if (harness !== "codex" && harness !== "claude") {
      throw new Usage("--harness must be codex or claude");
    }
    if ((values.scope ?? "project") !== "project") {
      throw new Usage("--scope must be project");
    }
    const approvals = skillAdoptions(values.adopt ?? []);
    if (approvals === null) {
      throw new Usage("give --adopt SKILL=SHA256 at most once per managed skill");
    }
    const checkout = projectRoot(systemGit(io.env), root);
    const result = syncManagedProjectSkills(io, checkout, harness, approvals);
    io.out(`${JSON.stringify({ ...result, schema: 1 })}\n`);
    if (result.status === "conflict") {
      for (const { path, reason, sha256, skill } of result.conflicts) {
        const review =
          sha256 === undefined
            ? ""
            : ` Review the file, then use --adopt ${skill}=${sha256} to replace these exact bytes.`;
        io.err(`coordination-kit: ${path}: ${reason}.${review}\n`);
      }
      return EXIT_INVALID;
    }
    return EXIT_OK;
  } catch (error) {
    io.err(
      `coordination-kit: ${error instanceof Usage ? errorMessage(error) : "skills-sync-failed"}\n`,
    );
    return error instanceof Usage ? EXIT_USAGE : EXIT_INVALID;
  }
};
