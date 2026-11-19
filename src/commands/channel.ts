// `coordination-kit claude channel`: the stdio MCP server that the recipient Claude session launches
// from game-coordinator's node_modules. It watches the conversation's wake file and emits one
// notification per seq increase. The conversation is `--conversation UUID`, else the Claude
// conversation of the one reports.recipient that every game (or each `--game`) names.
import { writeSync } from "node:fs";
import { parseArgs } from "node:util";

import { type LineWriter, serve } from "../adapters/claude/channel.ts";
import { writeChannelStatus } from "../adapters/claude/channelStatus.ts";
import { wakeFilePath, WakeWatcher } from "../adapters/claude/wakeFile.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import { gameRecipients } from "../config.ts";
import { EXIT_INVALID, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { gameLayout, loadLayout } from "../layout.ts";
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

/** The Claude conversation of the one reports.recipient the selected (or every) game names. */
function recipientConversation(root: string, games: string[] | undefined): string {
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
  const conversation = resolveConversation(registry, role);
  if (conversation === null) {
    throw new Error(`the recipient ${role} has no claude conversation`);
  }
  return conversation;
}

export async function runChannel(
  streams: ChannelStreams,
  io: Io,
  root: string,
  args: string[],
): Promise<number> {
  let conversation: string;
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
    conversation = values.conversation ?? recipientConversation(root, values.game);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`coordination-kit: ${message}\n`);
    return error instanceof ChannelUsage ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")
      ? EXIT_USAGE
      : EXIT_INVALID;
  }
  try {
    const layout = loadLayout(root);
    const identity = cliIdentity(io.entry);
    writeChannelStatus(layout, {
      argv: process.argv,
      conversation,
      distSha256: identity.distSha256,
      pid: process.pid,
      schema: 1,
      startedAt: new Date().toISOString(),
      version: identity.version,
    });
  } catch {
    // The status file is diagnostic only; the channel serves without it.
  }
  return serve(
    {
      pollMs: pollSeconds * 1000,
      wake: new WakeWatcher(() => wakeFilePath(loadLayout(root), conversation)),
    },
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
