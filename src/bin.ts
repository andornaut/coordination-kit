#!/usr/bin/env node
// The bundled dist/cli.js entry point.
import { fileURLToPath } from "node:url";

import { main } from "./cli.ts";

process.exitCode = await main(
  {
    cwd: process.cwd(),
    entry: fileURLToPath(import.meta.url),
    env: process.env,
    err: (text) => process.stderr.write(text),
    out: (text) => process.stdout.write(text),
  },
  process.argv.slice(2),
);
