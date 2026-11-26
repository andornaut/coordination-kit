// The channel server's status file: `<stateRoot>/channel/roles/<role>.json` (or
// `var/channel/roles/` without a configured state root), written when `claude channel` resolves
// its binding and rewritten after it verifies /clear lineage to a replacement. It is keyed by role, so
// `harness doctor` and the scheduled review find it after a /clear rebind. It names the binding
// the server serves, the CLI version and dist digest it loaded and its launch command, so both
// can report what a session is running and whether its channel follows the current binding
// without contacting it.
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
  /** The last Claude binding the channel proved it serves. */
  readonly conversation: string;
  readonly version: string;
  readonly distSha256: string;
  readonly pid: number;
  readonly startedAt: string;
  /** The server's own argv: the executable, then its arguments. */
  readonly argv: readonly string[];
}

function channelStatusPath(layout: Layout, role: string): string {
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

/** The status file as read: absent, unreadable (including malformed), or its valid content. */
type ChannelStatusRead =
  | { readonly state: "missing" }
  | { readonly state: "unreadable" }
  | { readonly state: "read"; readonly status: ChannelStatus };

function readChannelStatusFile(layout: Layout, role: string): ChannelStatusRead {
  let value: unknown;
  try {
    value = readJsonIfExists(channelStatusPath(layout, role));
  } catch {
    return { state: "unreadable" };
  }
  if (value === undefined) {
    return { state: "missing" };
  }
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
    return { state: "unreadable" };
  }
  return { state: "read", status: value as unknown as ChannelStatus };
}

/** The recorded status, or null when it is absent, unreadable or malformed. */
export function readChannelStatus(layout: Layout, role: string): ChannelStatus | null {
  const read = readChannelStatusFile(layout, role);
  return read.state === "read" ? read.status : null;
}

/**
 * Whether a Claude role's channel resolved to its current binding: `current` when the status file
 * names `binding`, `stale` when it names another conversation, `missing` when the channel wrote
 * none and `unreadable` when the file or its directory cannot be read or is malformed. A status
 * file shows that a channel resolved its role, never that it is still connected.
 */
export type ChannelResolution =
  | { readonly state: "missing" }
  | { readonly state: "unreadable" }
  | { readonly state: "current"; readonly status: ChannelStatus }
  | { readonly state: "stale"; readonly status: ChannelStatus };

export function channelResolution(
  layout: Layout,
  role: string,
  binding: string | null,
): ChannelResolution {
  const read = readChannelStatusFile(layout, role);
  if (read.state !== "read") {
    return read;
  }
  return read.status.conversation === binding
    ? { state: "current", status: read.status }
    : { state: "stale", status: read.status };
}
