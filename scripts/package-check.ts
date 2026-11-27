// Inspect a built package without claiming that its source snapshot is an immutable commit.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain, node, run } from "./check.ts";
import { packagedDocs } from "./docs-check.ts";

export interface CheckContext {
  readonly CHECK_REVISION: string;
  readonly CHECK_SOURCE_SHA256: string;
  readonly CHECK_SOURCE_DIRTY: boolean;
}

export function checkContext(env: Readonly<Record<string, string | undefined>>): CheckContext {
  const { CHECK_REVISION, CHECK_SOURCE_SHA256, CHECK_SOURCE_DIRTY } = env;
  if (
    CHECK_REVISION === undefined ||
    !/^[0-9a-f]{40}$/.test(CHECK_REVISION) ||
    CHECK_SOURCE_SHA256 === undefined ||
    !/^[0-9a-f]{64}$/.test(CHECK_SOURCE_SHA256) ||
    (CHECK_SOURCE_DIRTY !== "true" && CHECK_SOURCE_DIRTY !== "false")
  ) {
    throw new Error("container snapshot provenance is missing or invalid");
  }
  return { CHECK_REVISION, CHECK_SOURCE_SHA256, CHECK_SOURCE_DIRTY: CHECK_SOURCE_DIRTY === "true" };
}

export function inspectionContext(env: Readonly<Record<string, string | undefined>>) {
  const supplied = ["CHECK_REVISION", "CHECK_SOURCE_SHA256", "CHECK_SOURCE_DIRTY"].some(
    (key) => env[key] !== undefined,
  );
  return {
    kind: "snapshot-package-inspection" as const,
    immutableCommitClaim: false as const,
    ...(supplied ? checkContext(env) : {}),
  };
}

export function inspectPackage(
  env: Readonly<Record<string, string | undefined>>,
  root: string,
): void {
  const context = inspectionContext(env);
  const proof = mkdtempSync(join(tmpdir(), "coordination-kit-package-check-"));
  const packed = spawnSync(
    "npm",
    ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", proof],
    { cwd: root, encoding: "utf8" },
  );
  if (packed.status !== 0) throw new Error("package inspection failed: " + packed.stderr);
  const [metadata] = JSON.parse(packed.stdout) as [{ filename: string }];
  const archive = join(proof, metadata.filename),
    extracted = join(proof, "unpacked");
  mkdirSync(extracted);
  run(root, "tar", ["-xzf", archive, "-C", extracted]);
  const pkg = join(extracted, "package");
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as {
    version: string;
    exports: Record<string, string | { types: string; import: string }>;
  };
  if (manifest.version !== readFileSync(join(root, "VERSION"), "utf8").trim())
    throw new Error("package version differs from VERSION");
  for (const doc of packagedDocs(root))
    if (!existsSync(join(pkg, doc))) throw new Error(`package ${doc} is missing`);
  if (existsSync(join(pkg, "docs", "work"))) throw new Error("package must not contain docs/work");
  const version = spawnSync(process.execPath, [join(pkg, "dist/cli.js"), "--version"], {
    encoding: "utf8",
  });
  if (version.status !== 0 || version.stdout.trim() !== manifest.version)
    throw new Error("package CLI version differs from package.json");
  const skillsProject = join(proof, "skills-project");
  mkdirSync(skillsProject);
  run(skillsProject, "git", ["init", "--quiet", "--initial-branch=main"]);
  for (const [skill, harness, base, name] of [
    ["agent-cleanup", "codex", ".agents", "agent-cleanup"],
    ["agent-cleanup", "claude", ".claude", "agent-cleanup"],
    ["lifecycle", "codex", ".agents", "coordination-lifecycle"],
    ["status", "claude", ".claude", "coordination-status"],
  ] as const) {
    const path = join(base, "skills", name, "SKILL.md");
    const target = join(skillsProject, path);
    const asset = readFileSync(join(pkg, "skills", name, "SKILL.md"));
    const install = () =>
      spawnSync(
        process.execPath,
        [
          join(pkg, "dist/cli.js"),
          "skills",
          "install",
          skill,
          "--harness",
          harness,
          "--scope",
          "project",
        ],
        { cwd: skillsProject, encoding: "utf8" },
      );
    for (const installed of [true, false]) {
      const result = install();
      if (
        result.status !== 0 ||
        result.stdout.trim() !== JSON.stringify({ installed, path }) ||
        !readFileSync(target).equals(asset)
      ) {
        throw new Error(`packaged skill install differs: ${skill} ${result.stderr}`);
      }
    }
    writeFileSync(target, "Local instructions.\n");
    const conflict = install();
    if (
      conflict.status !== 1 ||
      !conflict.stderr.includes("review the existing entry") ||
      readFileSync(target, "utf8") !== "Local instructions.\n"
    ) {
      throw new Error("packaged skill install must preserve local changes: " + skill);
    }
  }
  const modules = ["registry", "review", "shared", "store"];
  const expectedExports = ["./package.json", ...modules.map((name) => `./build/${name}`)].sort();
  if (JSON.stringify(Object.keys(manifest.exports).sort()) !== JSON.stringify(expectedExports))
    throw new Error("package must export only explicit build APIs and metadata");
  if (manifest.exports["./package.json"] !== "./package.json")
    throw new Error("package metadata export differs");
  for (const name of modules) {
    const path = `./build/${name}`;
    const entry = manifest.exports[path];
    if (
      entry === undefined ||
      typeof entry === "string" ||
      entry.types !== `./dist/${name}.d.ts` ||
      entry.import !== `./dist/${name}.js` ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["import", "types"]) ||
      !existsSync(join(pkg, entry.types)) ||
      !existsSync(join(pkg, entry.import))
    ) {
      throw new Error("package build API target differs: " + path);
    }
  }
  node(pkg, "--input-type=module", [
    "-e",
    "import { readRegistry, resolveConversation, updateRegistry, LockBusy } from '@andornaut/coordination-kit/build/registry'; " +
      "import * as shared from '@andornaut/coordination-kit/build/shared'; " +
      "if (![readRegistry, resolveConversation, updateRegistry].every(value => typeof value === 'function')) process.exit(1); " +
      "if (shared.LockBusy !== LockBusy) throw new Error('API subpaths must share module instances');",
  ]);
  node(pkg, "--input-type=module", [
    "-e",
    "import { deliverReview, readRoleRoute, routeRecipient, storeReview } from '@andornaut/coordination-kit/build/review'; " +
      "import { Store, storeRetire, closeRequest, readRequests } from '@andornaut/coordination-kit/build/store'; " +
      "if (![deliverReview, readRoleRoute, routeRecipient, storeReview, Store, storeRetire, closeRequest, readRequests]" +
      ".every(value => typeof value === 'function')) process.exit(1);",
  ]);
  const consumer = join(proof, "consumer");
  const scope = join(consumer, "node_modules", "@andornaut");
  mkdirSync(scope, { recursive: true });
  symlinkSync(pkg, join(scope, "coordination-kit"), "dir");
  const source = join(consumer, "consumer.mts");
  const consumerSource = `import {
  readRegistry, updateRegistry, RevisionConflict, type Registry, type Layout,
} from "@andornaut/coordination-kit/build/registry";
import {
  deliverReview, readRoleRoute, type ReviewResult, type RoleRoute,
} from "@andornaut/coordination-kit/build/review";
import {
  holdLock, loadProjectConfig, writeJsonDurable, type Clock, type LockHandle, type ProjectConfig,
  type GameLayout,
} from "@andornaut/coordination-kit/build/shared";
import { Store, storeRetire, type RetireOutput } from "@andornaut/coordination-kit/build/store";
const revision: (registry: Registry) => number = registry => registry.revision;
// @ts-expect-error Registry declarations must preserve the numeric revision type.
const wrongRevision: (registry: Registry) => string = registry => registry.revision;
const clock: Clock = () => new Date(0);
const review = (layout: Layout, game: GameLayout): Promise<ReviewResult | undefined> =>
  deliverReview({ clock, env: {} }, layout, game, 0);
// @ts-expect-error A review slot is an epoch-seconds number.
deliverReview({ clock, env: {} }, {} as Layout, {} as GameLayout, "0");
const route = (layout: Layout): RoleRoute | null => readRoleRoute(layout);
const lock: (path: string) => LockHandle = (path) => holdLock(path);
const project = (path: string): ProjectConfig["reports"] => loadProjectConfig(path).reports;
const durable = (path: string) => writeJsonDurable(path, {});
const retired = (output: RetireOutput): boolean => output.applied;
const retire = storeRetire;
const open = (path: string): Store => Store.open(clock, path);
export { revision, wrongRevision, readRegistry, updateRegistry, RevisionConflict,
  review, route, lock, project, durable, retired, retire, open };
`;
  writeFileSync(source, consumerSource);

  node(consumer, join(root, "node_modules/typescript/bin/tsc"), [
    "--noEmit",
    "--strict",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2024",
    "--types",
    "node",
    "--typeRoots",
    join(root, "node_modules/@types"),
    source,
  ]);
  const result = {
    version: 1,
    ...context,
    packageVersion: manifest.version,
    archive: metadata.filename,
    archiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
    cliVersion: version.stdout.trim(),
    nodeNextExports: {
      source: "extracted-package",
      canonicalSpecifiers: modules.map((name) => `@andornaut/coordination-kit/build/${name}`),
      classification: "node-build-operations-only",
      status: "passed",
    },
    SOURCE_DATE_EPOCH: env.SOURCE_DATE_EPOCH ?? null,
  };
  writeFileSync(join(proof, "CHECK_CONTEXT.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ ...result, inspectionDirectory: proof }));
}

if (isMain(import.meta.url)) {
  try {
    inspectPackage(process.env, resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  } catch (error) {
    console.error("package-check: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
