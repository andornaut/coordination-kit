import { readdirSync } from "node:fs";

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
// WORKAROUND: https://github.com/un-ts/eslint-plugin-import-x/issues/569
import { createNodeResolver } from "eslint-plugin-import-x/node-resolver";
import noCycle from "eslint-plugin-import-x/rules/no-cycle";
import globals from "globals";
import ts from "typescript-eslint";

import { plugins, sourceRules, toolingRules } from "./eslint.config.base.mjs";

const KIT_FILES = ["src/**/*.ts"];
const TEST_FILES = ["src/**/*.test.ts", "scripts/**/*.test.ts"];
const CYCLE_FILES = ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"];

const IMPORT_X = {
  plugins: { "import-x": { rules: { "no-cycle": noCycle } } },
  settings: {
    "import-x/extensions": [".ts"],
    "import-x/resolver-next": [createNodeResolver({ extensions: [".ts", ".js"] })],
  },
};

// The bundles load nothing from disk after startup: only node: builtins and the kit's own modules.
const OUTSIDE_NODE = {
  message: "src/ imports only node: builtins and its own modules by relative path.",
  regex: "^(?!node:|\\.{1,2}/)",
};

// The layers of src/, lowest first, each a list of top-level folders. "" is the modules directly
// in src/: the CLI entry points and the public build barrels. A module imports only its own layer
// or a lower one, type-only imports and re-exports included; tests are exempt.
const LAYERS = [
  ["core"],
  ["registry"],
  ["workfiles"],
  ["adapters"],
  ["store"],
  ["review", "status", "work"],
  ["commands"],
  [""],
];

const SRC_FOLDERS = entries("src", true);
const SRC_MODULES = entries("src", false).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

const unplaced = SRC_FOLDERS.filter((folder) => !LAYERS.flat().includes(folder));
if (unplaced.length > 0) {
  throw new Error(`src/ folders in no layer: ${unplaced.join(", ")}`);
}

function entries(path, directories) {
  return readdirSync(new URL(path, import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() === directories)
    .map((entry) => entry.name);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// An import names a folder only by its path, so the pattern matches only a relative path that
// climbs straight into a higher layer's folder (`../commands/x.ts`) or module (`../cli.ts`). A
// folder's own subfolders are never forbidden to it.
function layerBoundary(folder, index) {
  const higher = LAYERS.slice(index + 1).flat();
  const own = folder === "" ? [] : entries(`src/${folder}`, true);
  const folders = higher.filter((name) => name !== "" && !own.includes(name)).map(escapeRegex);
  const modules = higher.includes("") ? SRC_MODULES.map(escapeRegex) : [];
  const forbidden = [
    ...(folders.length > 0 ? [`(?:${folders.join("|")})(?:/|$)`] : []),
    ...(modules.length > 0 ? [`(?:${modules.join("|")})$`] : []),
  ];
  return {
    files: [folder === "" ? "src/*.ts" : `src/${folder}/**/*.ts`],
    forbid:
      forbidden.length === 0
        ? undefined
        : {
            message: `src/${folder}${folder === "" ? "" : "/"} may import only its own layer or a lower one.`,
            regex: `^(?:\\.\\./)+(?:${forbidden.join("|")})`,
          },
  };
}

// A later no-restricted-imports replaces an earlier one rather than adding to it, so the configs
// partition the non-test files of src/: one config per layer folder, listing OUTSIDE_NODE and the
// folder's layer boundary.
function boundaryConfigs() {
  return LAYERS.flatMap((layer, index) => layer.map((folder) => layerBoundary(folder, index))).map(
    ({ files, forbid }) => ({
      files,
      ignores: TEST_FILES,
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: [OUTSIDE_NODE, ...(forbid === undefined ? [] : [forbid])] },
        ],
      },
    }),
  );
}

export default defineConfig(
  {
    ignores: [".claude/", "node_modules/", "dist/"],
  },
  js.configs.recommended,
  ts.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: KIT_FILES,
    plugins,
    rules: {
      ...sourceRules,
      "no-restricted-syntax": ["error", "WithStatement", "ImportExpression"],
    },
  },
  ...boundaryConfigs(),
  // No import cycles: a module in a cycle can run before what it imports has loaded. Type-only
  // imports are erased at build time, so they never form one. Under verbatimModuleSyntax an
  // import whose specifiers are all inline types still loads its module, so it must be written
  // as `import type`.
  {
    ...IMPORT_X,
    files: CYCLE_FILES,
    rules: {
      "import-x/no-cycle": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  // Tests and tooling: they verify or produce what ships rather than being it.
  {
    files: [...TEST_FILES, "*.ts", "*.js", "*.mjs", "scripts/**/*.mjs"],
    plugins,
    rules: toolingRules,
  },
);
