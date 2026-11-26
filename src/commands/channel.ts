// `coordination-kit claude channel`: the stdio MCP server that the recipient Claude session launches
// from game-coordinator's node_modules. It watches its role's wake file and emits one notification
// per seq increase. The role is the one whose Claude conversation is `--conversation UUID`, else
// the one reports.recipient that every game (or each `--game`) names. The wake file and the
// channel status file are keyed by role, so the channel keeps serving the role, and the doctor
// and the review keep finding its status, after `session start` rebinds it after /clear.
import { writeSync } from "node:fs";

import { type LineWriter, serve } from "../adapters/claude/channel.ts";
import { writeChannelStatus } from "../adapters/claude/channelStatus.ts";
import { wakeFilePath, WakeWatcher } from "../adapters/claude/wakeFile.ts";
import { gameRecipients } from "../core/config.ts";
import { isCanonicalUuid } from "../core/ids.ts";
import { EXIT_INVALID, EXIT_USAGE, type Io } from "../core/io.ts";
import { appLayout, gameLayout, type Layout, loadLayout } from "../core/layout.ts";
import { cliIdentity } from "../core/version.ts";
import { claudeProjectsDir, clearSuccessor } from "../registry/claudeLineage.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry, RegistryMissing } from "../registry/store.ts";
import { errorMessage, parseOptions, Usage } from "./args.ts";
import { SPECS } from "./spec.ts";

const DEFAULT_POLL_SECONDS = 5;

class ChannelUsage extends Error {}

/** The selected games' Claude recipient and its binding at launch. */
function recipientBinding(
  root: string,
  games: string[] | undefined,
): { conversation: string | null; role: string } {
  const layout = loadLayout(root);
  const recipients = gameRecipients(layout, games ?? Object.keys(layout.config.apps));
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
  return { conversation: resolveConversation(registry, role), role };
}

interface ChannelBinding {
  readonly conversation: string;
  readonly role: string;
}

/** The one role whose effective Claude conversation is `conversation`, else null. */
function boundConversation(registry: Registry, conversation: string): ChannelBinding | null {
  const roles = Object.keys(registry.roles).filter(
    (role) =>
      resolveHarness(registry, role) === "claude" &&
      resolveConversation(registry, role) === conversation,
  );
  return roles.length === 1 ? { conversation, role: roles[0]! } : null;
}

/** The most /clear steps followed from a launch conversation to a bound one. */
const LINEAGE_DEPTH = 16;
/** While unresolved, the transcript lineage is scanned at most this often. */
const LINEAGE_SCAN_MS = 60_000;
/** Once resolved, the role's binding is compared with the status file at most this often. */
const STATUS_CHECK_MS = 60_000;

/**
 * The role bound to `conversation`, or to the conversation its /clear lineage leads to. Claude
 * keeps a channel's launch argv for the session, so a reconnect after a rotation still names the
 * old ID. Each step needs exactly one cleared successor in any project directory; none or
 * several stops the walk.
 */
function lineageBinding(
  registry: Registry,
  projectsDir: string | null,
  conversation: string,
): ChannelBinding | null {
  if (projectsDir === null) {
    return null;
  }
  let current = conversation;
  for (let step = 0; step < LINEAGE_DEPTH; step++) {
    const next = clearSuccessor(projectsDir, current);
    if (next === null) {
      return null;
    }
    const binding = boundConversation(registry, next);
    if (binding !== null) {
      return binding;
    }
    current = next;
  }
  return null;
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

interface ChannelOptions {
  /** The MCP client's messages; defaults to stdin. */
  readonly input?: NodeJS.ReadableStream;
  /** Writes one protocol line; defaults to a synchronous write to stdout. */
  readonly write?: LineWriter;
  /** Claude's transcript directory; defaults to `claudeProjectsDir` of the environment. */
  readonly projectsDir?: string | null;
  /**
   * Milliseconds since the epoch, for the lineage scan, the status refresh and `startedAt`;
   * defaults to `Date.now`.
   */
  readonly now?: () => number;
}

/** The `claude channel` handler; serves until its input ends. */
export async function channel(
  io: Io,
  root: string,
  args: string[],
  options: ChannelOptions = {},
): Promise<number> {
  const input = options.input ?? process.stdin;
  const write = options.write ?? writeStdoutLine;
  let conversation: string | undefined;
  let role: string | undefined;
  let proven: string | null = null;
  let pollSeconds: number;
  try {
    const { values } = parseOptions(SPECS["claude channel"].options, args);
    pollSeconds = Number(values["poll-seconds"] ?? DEFAULT_POLL_SECONDS);
    if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
      throw new ChannelUsage("--poll-seconds must be a positive number");
    }
    if (values.conversation !== undefined && !isCanonicalUuid(values.conversation)) {
      throw new ChannelUsage("--conversation must be a canonical session UUID");
    }
    if (values.app !== undefined && values.game !== undefined) {
      throw new ChannelUsage("use --app or --game to select apps");
    }
    const apps = values.app ?? values.game;
    if (apps !== undefined) {
      if (apps.length !== new Set(apps).size) {
        throw new ChannelUsage(
          `each --${values.app === undefined ? "game" : "app"} may appear once`,
        );
      }
      const layout = loadLayout(root);
      const selectedLayout = values.app === undefined ? gameLayout : appLayout;
      apps.forEach((app) => selectedLayout(layout, app));
    }
    conversation = values.conversation;
    if (conversation === undefined) {
      const recipient = recipientBinding(root, apps);
      role = recipient.role;
      proven = recipient.conversation;
    }
  } catch (error) {
    const message = errorMessage(error);
    io.err(`coordination-kit: ${message}\n`);
    return error instanceof ChannelUsage || error instanceof Usage ? EXIT_USAGE : EXIT_INVALID;
  }
  const projectsDir =
    options.projectsDir === undefined ? claudeProjectsDir(io.env) : options.projectsDir;
  // Report the last proven binding. A registry replacement alone proves nothing about this
  // running channel. Status is diagnostic, so a failure never stops the channel.
  let reported: string | undefined;
  let checked: number | undefined;
  let startedAt: string | undefined;
  const report = (layout: Layout, known: string, at: number): void => {
    if (proven === null || (checked !== undefined && at - checked < STATUS_CHECK_MS)) {
      return;
    }
    checked = at;
    try {
      const registry = readRegistry(layout);
      if (
        resolveHarness(registry, known) === "claude" &&
        resolveConversation(registry, known) !== proven
      ) {
        const successor = lineageBinding(registry, projectsDir, proven);
        if (successor?.role === known) {
          proven = successor.conversation;
        }
      }
      if (proven === reported) {
        return;
      }
      const identity = cliIdentity(io.entry);
      startedAt ??= new Date(at).toISOString();
      if (
        writeChannelStatus(layout, {
          argv: process.argv,
          conversation: proven,
          distSha256: identity.distSha256,
          pid: process.pid,
          role: known,
          schema: 2,
          startedAt,
          version: identity.version,
        })
      ) {
        reported = proven;
      }
    } catch {
      // The channel serves without its status file.
    }
  };
  // `--conversation` names the role by its binding, else by the binding its /clear lineage
  // reaches, at start or at a later poll that finds one; the role then stays fixed while its
  // binding rotates.
  const now = options.now ?? Date.now;
  let scanned: number | undefined;
  const locate = (): string => {
    const layout = loadLayout(root);
    const at = now();
    if (role === undefined) {
      const registry = readRegistry(layout);
      let found = boundConversation(registry, conversation!);
      if (found === null && (scanned === undefined || at - scanned >= LINEAGE_SCAN_MS)) {
        scanned = at;
        found = lineageBinding(registry, projectsDir, conversation!);
      }
      if (found === null) {
        throw new Error(`no single claude role is bound to ${conversation}`);
      }
      role = found.role;
      proven = found.conversation;
    }
    report(layout, role, at);
    return wakeFilePath(layout, role);
  };
  try {
    locate();
  } catch {
    // The registry may not bind the conversation yet; each poll tries again.
  }
  return serve({ pollMs: pollSeconds * 1000, wake: new WakeWatcher(locate) }, input, write);
}
