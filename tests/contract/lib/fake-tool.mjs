// Fake external tools for contract cases. Each PATH entry is a shell wrapper that runs
// `node fake-tool.mjs <tool> ...args`. Every invocation is logged to DK_FAKE_DIR/calls.jsonl.
// Claude fixture responses come from DK_FAKE_DIR/control.json. Git authority checks use its
// scratch repository; every unmodelled invocation exits 98 after recording the call.
import { spawnSync } from "node:child_process";
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

const gitArgs = args.slice(4);
if (
  tool === "git" &&
  args[0] === "-c" &&
  args[1] === "core.quotePath=false" &&
  args[2] === "-c" &&
  args[3] === "log.showSignature=false" &&
  ["rev-parse", "check-ignore", "ls-files"].includes(gitArgs[0])
) {
  const PATH = process.env.PATH.split(":").slice(1).join(":");
  process.exit(
    spawnSync("git", args, { env: { ...process.env, PATH }, stdio: "inherit" }).status ?? 98,
  );
}

if (tool !== "claude") {
  process.stderr.write(`fake tool: unmodelled ${tool}\n`);
  process.exit(98);
}
process.exit(claude());
