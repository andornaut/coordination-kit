// `coordination-kit claude channel`: the stdio MCP server that the recipient Claude session launches
// from game-coordinator's node_modules. It watches its role's wake file and emits one notification
// per seq increase. The role is the one whose Claude conversation is `--conversation UUID`, else
// the one reports.recipient that every game (or each `--game`) names. The wake file and the
// channel status file are keyed by role, so the channel keeps serving the role, and the doctor
// keeps finding its status, after `session start` rebinds it after /clear.
import { writeSync } from "node:fs";
import { parseArgs } from "node:util";

import { type LineWriter, serve } from "../adapters/claude/channel.ts";
import { writeChannelStatus } from "../adapters/claude/channelStatus.ts";
import { wakeFilePath, WakeWatcher } from "../adapters/claude/wakeFile.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { gameRecipients } from "../config.ts";
import { EXIT_INVALID, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { gameLayout, type Layout, loadLayout } from "../layout.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import { readRegistry, RegistryMissing } from "../registry/store.ts";
import { cliIdentity } from "../version.ts";
import { SPECS } from "./spec.ts";

export interface ChannelStreams {
  readonly input: NodeJS.ReadableStream;
  readonly write: LineWriter;
}

const DEFAULT_POLL_SECONDS = 5;

class ChannelUsage extends Error {}

/** The one reports.recipient the selected (or every) game names, which must be on Claude. */
function recipientRole(root: string, games: string[] | undefined): string {
  const layout = loadLayout(root);
  const recipients = gameRecipients(layout, games ?? Object.keys(layout.config.games));
  if (recipients.length !== 1) {
    throw new Error(
      `the selected games name ${recipients.length === 0 ? "no" : "different"} ` +
        "reports.recipient roles; select games with one recipient, or pass --conversation UUID",
    );
  }
  const role = recipients[0] as string;
  let registry;
  try {
    registry = readRegistry(layout);
  } catch (error) {
    if (error instanceof RegistryMissing) {
      throw new Error(
        `${layout.registryFile} does not exist; create the registry first, or pass --conversation UUID`,
        { cause: error },
      );
    }
    throw error;
  }
  if (resolveHarness(registry, role) !== "claude") {
    throw new Error(`channel requires the claude harness for the recipient ${role}`);
  }
  return role;
}

/** The one role whose effective Claude conversation is `conversation`; throws until there is one. */
function conversationRole(layout: Layout, conversation: string): string {
  const registry = readRegistry(layout);
  const roles = Object.keys(registry.roles).filter(
    (role) =>
      resolveHarness(registry, role) === "claude" &&
      resolveConversation(registry, role) === conversation,
  );
  if (roles.length !== 1) {
    throw new Error(`no single claude role is bound to ${conversation}`);
  }
  return roles[0] as string;
}

export async function runChannel(
  streams: ChannelStreams,
  io: Io,
  root: string,
  args: string[],
): Promise<number> {
  let conversation: string | undefined;
  let role: string | undefined;
  let pollSeconds: number;
  try {
    const { values } = parseArgs({
      args,
      options: SPECS["claude channel"].options,
      strict: true,
    });
    pollSeconds = Number(values["poll-seconds"] ?? DEFAULT_POLL_SECONDS);
    if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
      throw new ChannelUsage("--poll-seconds must be a positive number");
    }
    if (values.conversation !== undefined && !isCanonicalUuid(values.conversation)) {
      throw new ChannelUsage("--conversation must be a canonical session UUID");
    }
    if (values.game !== undefined) {
      if (values.game.length !== new Set(values.game).size) {
        throw new ChannelUsage("each --game may appear once");
      }
      const layout = loadLayout(root);
      values.game.forEach((game) => gameLayout(layout, game));
    }
    conversation = values.conversation;
    role = conversation === undefined ? recipientRole(root, values.game) : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`coordination-kit: ${message}\n`);
    return error instanceof ChannelUsage ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
      ? EXIT_USAGE
      : EXIT_INVALID;
  }
  let reported = false;
  // Written once, when the role is known; diagnostic only, so a failure never stops the channel.
  const report = (layout: Layout, known: string): void => {
    if (reported) {
      return;
    }
    reported = true;
    try {
      const identity = cliIdentity(io.entry);
      writeChannelStatus(layout, {
        argv: process.argv,
        conversation: conversation ?? (resolveConversation(readRegistry(layout), known) as string),
        distSha256: identity.distSha256,
        pid: process.pid,
        role: known,
        schema: 2,
        startedAt: new Date().toISOString(),
        version: identity.version,
      });
    } catch {
      // The channel serves without its status file.
    }
  };
  // `--conversation` names the role by its binding at start, else at the first poll that finds
  // it; the role then stays fixed while its binding rotates.
  const locate = (): string => {
    const layout = loadLayout(root);
    role ??= conversationRole(layout, conversation!);
    report(layout, role);
    return wakeFilePath(layout, role);
  };
  try {
    locate();
  } catch {
    // The registry may not bind the conversation yet; each poll tries again.
  }
  return serve(
    { pollMs: pollSeconds * 1000, wake: new WakeWatcher(locate) },
    streams.input,
    streams.write,
  );
}

const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** stdout carries only protocol lines. A synchronous write surfaces a closed channel at once. */
function writeStdoutLine(line: string): void {
  const bytes = Buffer.from(line, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(1, bytes, offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") {
        throw error;
      }
      Atomics.wait(PAUSE, 0, 0, 10);
    }
  }
}

export const channel: Handler = (io, root, args) =>
  runChannel({ input: process.stdin, write: writeStdoutLine }, io, root, args);
