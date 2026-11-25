// Scoped selection is a revision-checked registry mutation, separate from provider activation.
import { parseArgs } from "node:util";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler } from "../core/io.ts";
import { loadLayout } from "../core/layout.ts";
import { dumpsJson } from "../core/pyjson.ts";
import { selectHarness } from "../registry/selection.ts";
import { commandUsage, SPECS } from "./spec.ts";

export const harnessSelect: Handler = (io, root, args) => {
  let values;
  try {
    const parsed = parseArgs({
      args,
      options: SPECS["harness select"].options,
      strict: true,
      tokens: true,
    });
    for (const name of ["harness", "expected-revision"]) {
      if (
        parsed.tokens.filter((token) => token.kind === "option" && token.name === name).length > 1
      ) {
        throw new Error(`--${name} must be given once`);
      }
    }
    values = parsed.values;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`coordination-kit: ${message}\n${commandUsage("harness select")}\n`);
    return EXIT_USAGE;
  }
  const { "expected-revision": revision, game, harness, role } = values;
  if (
    (harness !== "claude" && harness !== "codex" && harness !== "default") ||
    typeof revision !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(revision) ||
    !Number.isSafeInteger(Number(revision)) ||
    (game === undefined && role === undefined)
  ) {
    io.err(`${commandUsage("harness select")}\n`);
    return EXIT_USAGE;
  }
  try {
    const registry = selectHarness(loadLayout(root), Number(revision), {
      ...(game === undefined ? {} : { games: game }),
      harness,
      ...(role === undefined ? {} : { roles: role }),
    });
    io.out(`${dumpsJson(registry)}\n`);
    return EXIT_OK;
  } catch (error) {
    io.err(`coordination-kit: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_INVALID;
  }
};
