// Fake external tools for contract cases. Each PATH entry is a shell wrapper that runs
// `node fake-tool.mjs <tool> ...args`. Every invocation is logged to DK_FAKE_DIR/calls.jsonl.
// Only `claude agents --json` is modelled, from DK_FAKE_DIR/control.json read on every
// invocation; the other tools exit 98 so an unexpected call fails visibly as well as being logged.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [, , tool, ...args] = process.argv;
const dir = process.env.DK_FAKE_DIR;
if (!dir) {
  process.stderr.write("fake tool: DK_FAKE_DIR is required\n");
  process.exit(97);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ tool, args, cwd: process.cwd() }) + "\n");

function claude() {
  const behaviour = readJson(join(dir, "control.json"), {}).claude ?? {};
  if (args[0] !== "agents") return 2;
  if (behaviour.exitCode) return behaviour.exitCode;
  const agents = behaviour.agents ?? [];
  process.stdout.write(typeof agents === "string" ? agents : JSON.stringify(agents));
  return 0;
}

if (tool !== "claude") {
  process.stderr.write(`fake tool: unmodelled ${tool}\n`);
  process.exit(98);
}
process.exit(claude());
