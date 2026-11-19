// The channel server's status file: `<stateRoot>/channel/<conversation>.json` (or
// `var/channel/` without a configured state root), written once when `claude channel` starts. It
// names the CLI version and dist digest the server loaded and its launch command, so
// `harness doctor` can report what a session is running without contacting it.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { readJsonIfExists, writeJsonDurable } from "../../durable.ts";
import type { Layout } from "../../layout.ts";
import { stateRoot } from "../../stateRoot.ts";
import { canonicalUuid } from "../shared/ids.ts";
import { isRecord } from "../shared/pyjson.ts";

export interface ChannelStatus {
  readonly schema: 1;
  readonly conversation: string;
  readonly version: string;
  readonly distSha256: string;
  readonly pid: number;
  readonly startedAt: string;
  /** The server's own argv: the executable, then its arguments. */
  readonly argv: readonly string[];
}

export function channelStatusPath(layout: Layout, conversation: string): string {
  const root = stateRoot(layout);
  return join(root, "channel", `${canonicalUuid(conversation)}.json`);
}

/** Write the status atomically; a failure never stops the channel. */
export function writeChannelStatus(layout: Layout, status: ChannelStatus): boolean {
  try {
    const path = channelStatusPath(layout, status.conversation);
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    writeJsonDurable(path, status);
    return true;
  } catch {
    return false;
  }
}

/** The recorded status, or null when it is absent, unreadable or malformed. */
export function readChannelStatus(layout: Layout, conversation: string): ChannelStatus | null {
  try {
    const value = readJsonIfExists(channelStatusPath(layout, conversation));
    if (
      !isRecord(value) ||
      value.schema !== 1 ||
      value.conversation !== conversation ||
      typeof value.version !== "string" ||
      typeof value.distSha256 !== "string" ||
      !Number.isSafeInteger(value.pid) ||
      typeof value.startedAt !== "string" ||
      !Array.isArray(value.argv) ||
      !value.argv.every((item) => typeof item === "string")
    ) {
      return null;
    }
    return value as unknown as ChannelStatus;
  } catch {
    return null;
  }
}
