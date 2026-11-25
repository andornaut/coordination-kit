// The channel server's status file: `<stateRoot>/channel/roles/<role>.json` (or
// `var/channel/roles/` without a configured state root), written once when `claude channel` knows
// its role. It is keyed by role like the wake files, so `harness doctor` finds it after a /clear
// rebind. It names the CLI version and dist digest the server loaded and its launch command, so
// the doctor can report what a session is running without contacting it.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { readJsonIfExists, writeJsonDurable } from "../../core/durable.ts";
import { isCanonicalUuid } from "../../core/ids.ts";
import type { Layout } from "../../core/layout.ts";
import { isRecord } from "../../core/pyjson.ts";
import { stateRoot } from "../../core/stateRoot.ts";

const ROLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;

interface ChannelStatus {
  readonly schema: 2;
  readonly role: string;
  /** The role's Claude conversation when the channel wrote the file. */
  readonly conversation: string;
  readonly version: string;
  readonly distSha256: string;
  readonly pid: number;
  readonly startedAt: string;
  /** The server's own argv: the executable, then its arguments. */
  readonly argv: readonly string[];
}

export function channelStatusPath(layout: Layout, role: string): string {
  if (!ROLE.test(role)) {
    throw new Error("channel status needs a role name");
  }
  return join(stateRoot(layout), "channel", "roles", `${role}.json`);
}

/** Write the status atomically; a failure never stops the channel. */
export function writeChannelStatus(layout: Layout, status: ChannelStatus): boolean {
  try {
    const path = channelStatusPath(layout, status.role);
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    writeJsonDurable(path, status);
    return true;
  } catch {
    return false;
  }
}

/** The recorded status, or null when it is absent, unreadable or malformed. */
export function readChannelStatus(layout: Layout, role: string): ChannelStatus | null {
  try {
    const value = readJsonIfExists(channelStatusPath(layout, role));
    if (
      !isRecord(value) ||
      value.schema !== 2 ||
      value.role !== role ||
      !isCanonicalUuid(value.conversation) ||
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
