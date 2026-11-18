// coordination-kit command dispatcher. Every command is a noun group and its verb. Commands resolve
// game-coordinator from --root (in any position, once), COORDINATION_KIT_ROOT, DELIVERY_KIT_ROOT or
// the working directory, in that order; the work group reads --root as the repository instead.
import {
  ledgerApply,
  ledgerBoundary,
  ledgerCoverage,
  ledgerHistory,
  ledgerIntake,
  ledgerReconcile,
  ledgerReport,
  ledgerShow,
} from "./commands/accounting.ts";
import { channel } from "./commands/channel.ts";
import { harnessDoctor } from "./commands/doctor.ts";
import { harnessSelect } from "./commands/harness.ts";
import { inboxAck, inboxSnapshot } from "./commands/inbox.ts";
import {
  messageDispatch,
  messageReconcile,
  messageRetireSpool,
  messageSend,
  messageStatus,
} from "./commands/messages.ts";
import {
  protocolActivate,
  protocolArtifactPut,
  protocolArtifactRead,
  protocolBackup,
  protocolBoundary,
  protocolClaim,
  protocolDeclare,
  protocolDryRun,
  protocolEnroll,
  protocolEnrollmentReport,
  protocolEnrollSelf,
  protocolImport,
  protocolImportOriginals,
  protocolInbox,
  protocolIntake,
  protocolInventory,
  protocolMessageObserve,
  protocolMessagePublish,
  protocolMessageReceipt,
  protocolMessageWithdraw,
  protocolObserverAdoption,
  protocolOriginal,
  protocolRestore,
  protocolRoleRead,
  protocolStatus,
  protocolWorkAccept,
  protocolWorkPublish,
  protocolWorkRead,
  protocolWorkReceipt,
  protocolWorkSubmit,
} from "./commands/protocol.ts";
import { claudeReady, codexReady, harnessReady } from "./commands/ready.ts";
import { eventsFlush, reviewDeliver } from "./commands/runner.ts";
import { type Command, GROUPS, SPECS, synopsis } from "./commands/spec.ts";
import { workCheck, workReport } from "./commands/work.ts";
import { coordinatorRoot, EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "./io.ts";
import { cliIdentity, VERSION } from "./version.ts";
export { EXIT_INVALID, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, type Handler, type Io } from "./io.ts";
export { SOURCE_DIGEST, VERSION } from "./version.ts";
export const COMMANDS = [
  "inbox snapshot",
  "inbox ack",
  "claude ready",
  "codex ready",
  "harness doctor",
  "harness ready",
  "harness select",
  "claude channel",
  "review deliver",
  "events flush",
  "message send",
  "message dispatch",
  "message status",
  "message reconcile",
  "message retire-spool",
  "ledger intake",
  "ledger apply",
  "ledger show",
  "ledger report",
  "ledger history",
  "ledger coverage",
  "ledger reconcile",
  "ledger boundary",
  "protocol status",
  "protocol inventory",
  "protocol dry-run",
  "protocol declare",
  "protocol enroll",
  "protocol enroll-self",
  "protocol enrollment-report",
  "protocol observer-adoption",
  "protocol import",
  "protocol import-originals",
  "protocol backup",
  "protocol restore",
  "protocol activate",
  "protocol claim",
  "protocol role",
  "protocol artifact-put",
  "protocol artifact-read",
  "protocol work-publish",
  "protocol work-read",
  "protocol work-submit",
  "protocol work-accept",
  "protocol work-receipt",
  "protocol message-publish",
  "protocol message-original",
  "protocol message-receipt",
  "protocol message-withdraw",
  "protocol message-observe",
  "protocol inbox",
  "protocol intake",
  "protocol boundary",
  "work check",
  "work report",
] as const satisfies readonly Command[];
export type { Command };
const GROUP_ORDER = [
  "inbox",
  "message",
  "ledger",
  "harness",
  "review",
  "protocol",
  "work",
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
  "Inbox --recipient and --parent take a role name resolved through var/registry.json, or a",
  "conversation UUID registered for the active harness. Repeat --parent UUID for each parent.",
  "",
  "  help, --help      print this text",
  "  --version         print the version",
  "  --version --json  print {schema, version, distSha256} as one JSON line",
  "",
  "game-coordinator is --root (in any position, once), else COORDINATION_KIT_ROOT, else",
  "DELIVERY_KIT_ROOT, else the working directory. For work check and work report, --root names",
  "the repository (default: the working directory) and the coordinator root comes only from",
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
  "events flush": eventsFlush,
  "harness doctor": harnessDoctor,
  "harness ready": harnessReady,
  "harness select": harnessSelect,
  "inbox ack": inboxAck,
  "inbox snapshot": inboxSnapshot,
  "ledger apply": ledgerApply,
  "ledger boundary": ledgerBoundary,
  "ledger coverage": ledgerCoverage,
  "ledger history": ledgerHistory,
  "ledger intake": ledgerIntake,
  "ledger reconcile": ledgerReconcile,
  "ledger report": ledgerReport,
  "ledger show": ledgerShow,
  "message dispatch": messageDispatch,
  "message reconcile": messageReconcile,
  "message retire-spool": messageRetireSpool,
  "message send": messageSend,
  "message status": messageStatus,
  "protocol activate": protocolActivate,
  "protocol artifact-put": protocolArtifactPut,
  "protocol artifact-read": protocolArtifactRead,
  "protocol backup": protocolBackup,
  "protocol boundary": protocolBoundary,
  "protocol claim": protocolClaim,
  "protocol declare": protocolDeclare,
  "protocol dry-run": protocolDryRun,
  "protocol enroll": protocolEnroll,
  "protocol enroll-self": protocolEnrollSelf,
  "protocol enrollment-report": protocolEnrollmentReport,
  "protocol import": protocolImport,
  "protocol import-originals": protocolImportOriginals,
  "protocol inbox": protocolInbox,
  "protocol intake": protocolIntake,
  "protocol inventory": protocolInventory,
  "protocol message-observe": protocolMessageObserve,
  "protocol message-original": protocolOriginal,
  "protocol message-publish": protocolMessagePublish,
  "protocol message-receipt": protocolMessageReceipt,
  "protocol message-withdraw": protocolMessageWithdraw,
  "protocol observer-adoption": protocolObserverAdoption,
  "protocol restore": protocolRestore,
  "protocol role": protocolRoleRead,
  "protocol status": protocolStatus,
  "protocol work-accept": protocolWorkAccept,
  "protocol work-publish": protocolWorkPublish,
  "protocol work-read": protocolWorkRead,
  "protocol work-receipt": protocolWorkReceipt,
  "protocol work-submit": protocolWorkSubmit,
  "review deliver": reviewDeliver,
  "work check": workCheck,
  "work report": workReport,
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
/** The command a line names: a noun group and its verb. */
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
