// Static checks on the bundles built before the unit suite, and the packed file list.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { packagedDocs } from "./docs-check.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIBRARIES = ["registry", "review", "shared", "store"];
const BUNDLES = ["dist/cli.js", ...LIBRARIES.map((name) => `dist/${name}.js`)];
const SKILLS = [
  "skills/agent-cleanup/SKILL.md",
  "skills/coordination-handoff/SKILL.md",
  "skills/coordination-lifecycle/SKILL.md",
  "skills/coordination-recovery/SKILL.md",
  "skills/coordination-status/SKILL.md",
];
const METADATA = ["LICENSE", "SOURCE_COMMIT", "package.json", ...packagedDocs(root), ...SKILLS];

beforeAll(() => {
  for (const bundle of BUNDLES) {
    if (!existsSync(join(root, bundle))) {
      throw new Error(`${bundle} is missing; run npm run build before running units`);
    }
  }
});

describe("dist/cli.js", () => {
  it("is an executable Node script that reports the package version", () => {
    const cli = join(root, "dist/cli.js");
    expect(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version: string;
    };
    expect(execFileSync(cli, ["--version"], { encoding: "utf8" })).toBe(`${version}\n`);
    const run = spawnSync(cli, ["work", "check", "--bogus"], { encoding: "utf8" });
    expect([run.status, run.stderr]).toEqual([
      2,
      "coordination-kit: usage: coordination-kit work check [--decisions] [--root DIR]\n",
    ]);
  });

  it("imports only node: builtins, and each API bundle only builtins and shared chunks", () => {
    const specifiers = (path: string) =>
      [
        ...readFileSync(join(root, path), "utf8").matchAll(
          /^(?:import|export)\b[^;]*?from\s*"([^"]+)"/gms,
        ),
      ].map((match) => match[1]);
    expect(specifiers("dist/cli.js").filter((name) => !name?.startsWith("node:"))).toEqual([]);
    const chunks = readdirSync(join(root, "dist/chunks")).map((name) => `dist/chunks/${name}`);
    for (const path of [...LIBRARIES.map((name) => `dist/${name}.js`), ...chunks]) {
      expect(
        specifiers(path).filter(
          (name) => !name?.startsWith("node:") && !/^\.\.?\//.test(name ?? ""),
        ),
        path,
      ).toEqual([]);
    }
  });

  it("exports from each API bundle exactly the names its source entry exports", async () => {
    const review = (await import(join(root, "dist/review.js"))) as Record<string, unknown>;
    expect(review.deliverReview).toBeTypeOf("function");
    expect(review).not.toHaveProperty("deliverScheduledReview");
    const apis = await Promise.all(
      LIBRARIES.map(
        async (name) => (await import(join(root, `dist/${name}.js`))) as Record<string, unknown>,
      ),
    );
    apis.forEach((api, index) =>
      expect(
        Object.keys(api).filter((key) => key.length < 3),
        LIBRARIES[index],
      ).toEqual([]),
    );
  });

  it("gives every API subpath one shared instance of each common module", async () => {
    const registry = (await import(join(root, "dist/registry.js"))) as Record<string, unknown>;
    const shared = (await import(join(root, "dist/shared.js"))) as Record<string, unknown>;
    expect(registry.LockBusy).toBe(shared.LockBusy);
    expect(registry.loadLayout).toBe(shared.loadLayout);
  });
});

describe("dist/registry.js", () => {
  it("exports public APIs with declarations a NodeNext consumer can type-check", async () => {
    const registry = (await import(join(root, "dist/registry.js"))) as Record<string, unknown>;
    for (const name of [
      "RegistrySchema",
      "readRegistry",
      "updateRegistry",
      "resolveConversation",
      "loadLayout",
    ]) {
      expect(registry[name], name).toBeDefined();
    }
    const consumer = join(mkdtempSync(join(tmpdir(), "registry-consumer-")), "consumer.mts");
    const target = JSON.stringify(join(root, "dist/registry.js"));
    writeFileSync(
      consumer,
      `import { readRegistry, type Registry, RevisionConflict, updateRegistry } from ${target};
import { type RetireOutput, storeRetire } from ${JSON.stringify(join(root, "dist/store.js"))};
const applied = (output: RetireOutput): boolean => output.applied;
// @ts-expect-error Retirement output keeps a boolean applied flag.
const notApplied: (output: RetireOutput) => string = (output) => output.applied;
export { applied, notApplied, storeRetire };
const check: (registry: Registry) => number = (registry) => registry.revision;
// @ts-expect-error A resolved Registry type rejects this; an unresolved one would be any.
const wrong: (registry: Registry) => string = (registry) => registry.revision;
export { check, wrong, readRegistry, RevisionConflict, updateRegistry };
`,
    );
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2024",
        "--skipLibCheck",
        "--types",
        "node",
        "--typeRoots",
        join(root, "node_modules/@types"),
        consumer,
      ],
      { cwd: dirname(consumer), stdio: "inherit" },
    );
  });
});

describe("packed package", () => {
  it("contains exactly the bundles, declarations, skills and metadata", () => {
    const [pack] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--offline", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as [{ files: { path: string }[] }];
    const files = pack.files.map((file) => file.path).sort();
    const dist = files.filter((path) => path.startsWith("dist/"));
    expect(files.filter((path) => !path.startsWith("dist/") && !METADATA.includes(path))).toEqual(
      [],
    );
    expect(METADATA.filter((path) => path.startsWith("docs/") && !files.includes(path))).toEqual(
      [],
    );
    expect(files.filter((path) => path.startsWith("skills/"))).toEqual(SKILLS);
    expect(files.filter((path) => path.startsWith("docs/work/"))).toEqual([]);
    expect(
      dist.filter((path) => !path.startsWith("dist/types/") && !path.startsWith("dist/chunks/")),
    ).toEqual(
      [
        "dist/cli.js",
        ...LIBRARIES.flatMap((name) => [`dist/${name}.d.ts`, `dist/${name}.js`]),
      ].sort(),
    );
    expect(
      dist.filter((path) => path.startsWith("dist/types/") && !path.endsWith(".d.ts")),
    ).toEqual([]);
    expect(dist.filter((path) => path.startsWith("dist/chunks/") && !path.endsWith(".js"))).toEqual(
      [],
    );
    expect(readdirSync(join(root, "dist")).sort()).toEqual(
      [
        "chunks",
        "cli.js",
        "types",
        ...LIBRARIES.flatMap((name) => [`${name}.d.ts`, `${name}.js`]),
      ].sort(),
    );
  });
});
