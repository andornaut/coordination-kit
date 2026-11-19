// Build the self-contained CLI bundle and the public API bundles with declarations. dist/cli.js
// imports only node: builtins, so a running process never reads its package again after startup.
// The API bundles share their common modules through dist/chunks/, so a consumer importing several
// subpaths gets one instance of each module, its classes and its locks.
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "vite";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const LIBRARIES = {
  accounting: "src/accounting.ts",
  events: "src/events.ts",
  protocol: "src/protocol.ts",
  registry: "src/registry/index.ts",
  review: "src/review.ts",
  shared: "src/shared.ts",
  store: "src/store.ts",
  transport: "src/transport.ts",
};
const COMMON = {
  configFile: false,
  define: { __CK_VERSION__: JSON.stringify(version) },
  logLevel: "warn",
  ssr: { noExternal: true, target: "node" },
};
const OUTPUT = {
  copyPublicDir: false,
  minify: false,
  outDir: "dist",
  reportCompressedSize: false,
  sourcemap: false,
  target: "node24",
};

await build({
  ...COMMON,
  build: {
    ...OUTPUT,
    emptyOutDir: true,
    rolldownOptions: {
      output: { codeSplitting: false, entryFileNames: "cli.js", format: "es" },
    },
    ssr: "src/bin.ts",
  },
});
await build({
  ...COMMON,
  build: {
    ...OUTPUT,
    emptyOutDir: false,
    rolldownOptions: {
      input: LIBRARIES,
      // Each entry exports exactly its own API; shared code moves to chunks, never an entry.
      preserveEntrySignatures: "strict",
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
        entryFileNames: "[name].js",
        format: "es",
      },
    },
    ssr: true,
  },
});
chmodSync("dist/cli.js", 0o755);

execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.types.json"], {
  stdio: "inherit",
});
// Declarations keep the source's relative .ts specifiers; consumers resolve the emitted .js names.
for (const name of readdirSync("dist/types", { recursive: true })) {
  if (name.endsWith(".d.ts")) {
    const path = join("dist/types", name);
    writeFileSync(path, readFileSync(path, "utf8").replace(/"(\.{1,2}\/[^"]+)\.ts"/g, '"$1.js"'));
  }
}
for (const [name, entry] of Object.entries(LIBRARIES)) {
  const types = entry.replace(/^src\//, "./types/").replace(/\.ts$/, ".js");
  writeFileSync(`dist/${name}.d.ts`, `export * from "${types}";\n`);
}
