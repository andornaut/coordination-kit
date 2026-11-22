// coordination-kit command dispatcher. Every command is a noun group and its verb. Commands resolve
// game-coordinator from --root (in any position, once), COORDINATION_KIT_ROOT, DELIVERY_KIT_ROOT or
// the working directory, in that order; the work group reads --root as the repository instead.
import { channel } from "./commands/channel.ts";
import { harnessDoctor } from "./commands/doctor.ts";
import { graph, graphIndex, graphWhy } from "./commands/graph.ts";
import { harnessSelect } from "./commands/harness.ts";
import {
  decisionList,
  holdList,
  holdRelease,
  holdSet,
  policyHoldRelease,
  policyHoldSet,
  questionAnswer,
  questionCancel,
  questionList,
  questionOpen,
  questionProject,
} from "./commands/questions.ts";
import { claudeReady, codexReady, harnessReady } from "./commands/ready.ts";
import { requestClose } from "./commands/requests.ts";
import { eventsIngest, reviewDeliver, reviewShow } from "./commands/runner.ts";
import {
  handoffActive,
  handoffOpen,
  handoffReady,
  handoffShow,
  handoffState,
  sessionStart,
} from "./commands/session.ts";
import { type Command, GROUPS, SPECS, synopsis } from "./commands/spec.ts";
import { status } from "./commands/status.ts";
import {
  inbox,
  msgDone,
  msgHistory,
  msgRetain,
  msgSend,
  msgStatus,
  storeExportCommand,
  storeImportCommand,
  storeRebuildCommand,
  storeRetireCommand,
} from "./commands/store.ts";
import {
  workBlock,
  workCheck,
  workEvidence,
  workFinish,
  workHistory,
  workReady,
  workReport,
  workShow,
  workStart,
  workUnblock,
} from "./commands/work.ts";
import { coordinatorRoot, EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "./io.ts";
import { cliIdentity, VERSION } from "./version.ts";
export { EXIT_INVALID, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, type Handler, type Io } from "./io.ts";
export { SOURCE_DIGEST, VERSION } from "./version.ts";
export const COMMANDS = [
  "msg send",
  "inbox",
  "msg done",
  "msg retain",
  "msg status",
  "msg history",
  "store import",
  "store export",
  "store rebuild",
  "store retire",
  "question open",
  "question answer",
  "question project",
  "question cancel",
  "question list",
  "hold set",
  "hold policy-set",
  "hold policy-release",
  "hold release",
  "hold list",
  "decision list",
  "session start",
  "handoff open",
  "handoff ready",
  "handoff state",
  "handoff active",
  "handoff show",
  "request close",
  "claude ready",
  "codex ready",
  "harness doctor",
  "harness ready",
  "harness select",
  "claude channel",
  "review deliver",
  "review show",
  "events ingest",
  "status",
  "work check",
  "work report",
  "work start",
  "work evidence",
  "work block",
  "work unblock",
  "work ready",
  "work finish",
  "work show",
  "work history",
  "graph",
  "graph why",
  "graph index",
] as const satisfies readonly Command[];
export type { Command };
const GROUP_ORDER = [
  "msg",
  "store",
  "decisions",
  "session",
  "request",
  "harness",
  "review",
  "status",
  "work",
  "graph",
] as const;
/** Help text, generated from each command's parser options and grouped by audience. */
export const USAGE = [
  "usage: coordination-kit COMMAND [options] [--root DIR]",
  ...GROUP_ORDER.flatMap((group) => [
    "",
    `${GROUPS[group][0]?.toUpperCase() ?? ""}${GROUPS[group].slice(1)}:`,
    ...COMMANDS.filter((command) => SPECS[command].group === group).flatMap((command) => [
      ...synopsis(command).map((line) => `  ${line}`),
      `      ${SPECS[command].summary}`,
    ]),
  ]),
  "",
  "  help, --help      print this text",
  "  --version         print the version",
  "  --version --json  print {schema, version, distSha256} as one JSON line",
  "",
  "game-coordinator is --root (in any position, once), else COORDINATION_KIT_ROOT, else",
  "DELIVERY_KIT_ROOT, else the working directory. For the work commands, --root names the",
  "repository (default: the working directory) and the coordinator root comes only from",
  "COORDINATION_KIT_ROOT or DELIVERY_KIT_ROOT.",
  "",
].join("\n");
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const HANDLERS: Readonly<Record<Command, Handler>> = {
  "claude channel": channel,
  "claude ready": claudeReady,
  "codex ready": codexReady,
  "decision list": decisionList,
  "events ingest": eventsIngest,
  graph,
  "graph index": graphIndex,
  "graph why": graphWhy,
  "handoff active": handoffActive,
  "handoff open": handoffOpen,
  "handoff ready": handoffReady,
  "handoff show": handoffShow,
  "handoff state": handoffState,
  "harness doctor": harnessDoctor,
  "harness ready": harnessReady,
  "harness select": harnessSelect,
  "hold list": holdList,
  "hold policy-release": policyHoldRelease,
  "hold policy-set": policyHoldSet,
  "hold release": holdRelease,
  "hold set": holdSet,
  inbox,
  "msg done": msgDone,
  "msg history": msgHistory,
  "msg retain": msgRetain,
  "msg send": msgSend,
  "msg status": msgStatus,
  "question answer": questionAnswer,
  "question cancel": questionCancel,
  "question list": questionList,
  "question open": questionOpen,
  "question project": questionProject,
  "request close": requestClose,
  "review deliver": reviewDeliver,
  "review show": reviewShow,
  "session start": sessionStart,
  status,
  "store export": storeExportCommand,
  "store import": storeImportCommand,
  "store rebuild": storeRebuildCommand,
  "store retire": storeRetireCommand,
  "work block": workBlock,
  "work check": workCheck,
  "work evidence": workEvidence,
  "work finish": workFinish,
  "work history": workHistory,
  "work ready": workReady,
  "work report": workReport,
  "work show": workShow,
  "work start": workStart,
  "work unblock": workUnblock,
};
/** Take every `--root DIR` out of the arguments; at most one is allowed. */
function extractRoot(args: string[]): {
  root?: string;
  error?: string;
} {
  const at = args.indexOf("--root");
  if (at < 0) {
    return {};
  }
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) {
    return { error: "--root needs a directory" };
  }
  args.splice(at, 2);
  if (args.includes("--root")) {
    return { error: "--root is given more than once" };
  }
  return { root: value };
}
/** The command a line names: a noun group and its verb, or a single-word command. */
function commandOf(args: readonly string[]):
  | {
      command: Command;
      rest: string[];
    }
  | undefined {
  const [first = "", second = ""] = args;
  const pair = `${first} ${second}`;
  if ((COMMANDS as readonly string[]).includes(pair)) {
    return { command: pair as Command, rest: args.slice(2) };
  }
  if ((COMMANDS as readonly string[]).includes(first) && !first.includes(" ")) {
    return { command: first as Command, rest: args.slice(1) };
  }
  return undefined;
}
export async function main(io: Io, argv: readonly string[]): Promise<number> {
  const args = [...argv];
  const extracted = extractRoot(args);
  if (extracted.error !== undefined) {
    io.err(`coordination-kit: ${extracted.error}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const [word] = args;
  if (word === "help" || word === "--help") {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (word === "--version") {
    if (args[1] !== "--json") {
      io.out(`${VERSION}\n`);
      return EXIT_OK;
    }
    try {
      const { distSha256, version } = cliIdentity(io.entry);
      io.out(
        `${JSON.stringify(
          Object.fromEntries([
            ["schema", 1],
            ["version", version],
            ["distSha256", distSha256],
          ]),
        )}\n`,
      );
      return EXIT_OK;
    } catch (error) {
      io.err(`coordination-kit: ${errorMessage(error)}\n`);
      return EXIT_INVALID;
    }
  }
  const found = commandOf(args);
  if (found === undefined) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const root =
    SPECS[found.command].group === "work"
      ? (extracted.root ?? io.cwd)
      : (extracted.root ?? coordinatorRoot(io.env) ?? io.cwd);
  try {
    return await HANDLERS[found.command](io, root, found.rest);
  } catch (error) {
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return EXIT_USAGE;
  }
}
