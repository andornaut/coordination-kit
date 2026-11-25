// Per-role wake files. `<stateRoot>/wake/roles/<role>.json` (or `var/wake/roles/` without a
// configured state root) holds `{"schema":1,"seq":N,"role":ROLE,"count":C}` with a monotonic `seq`.
// A game role's file is `<game>/<role>.json` under that directory. A writer replaces it
// atomically; the Claude channel serving the role announces each increase once, whichever
// conversation the role is bound to. A wake carries no payload: the recipient pulls its messages.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { readJsonIfExists, writeJsonDurable } from "../../core/durable.ts";
import type { Layout } from "../../core/layout.ts";
import { withLock } from "../../core/lock.ts";
import { isRecord } from "../../core/pyjson.ts";
import { stateRoot } from "../../core/stateRoot.ts";

export interface Wake {
  readonly seq: number;
  readonly role: string;
  readonly count: number;
}

const KEYS = ["count", "role", "schema", "seq"];
const ROLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;

/** The wake file of `role`: under the state root. */
export function wakeFilePath(layout: Layout, role: string): string {
  if (!ROLE.test(role)) {
    throw new Error("wake needs a role name");
  }
  return join(stateRoot(layout), "wake", "roles", `${role}.json`);
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** The wake at `path`; "absent" when there is no file, "invalid" when it is torn or malformed. */
export function readWakeFile(path: string): Wake | "absent" | "invalid" {
  let value: unknown;
  try {
    value = readJsonIfExists(path);
  } catch {
    return "invalid";
  }
  if (value === undefined) {
    return "absent";
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== KEYS.join(",") ||
    value.schema !== 1 ||
    !positive(value.seq) ||
    !positive(value.count) ||
    typeof value.role !== "string" ||
    !ROLE.test(value.role)
  ) {
    return "invalid";
  }
  return { count: value.count, role: value.role, seq: value.seq };
}

/**
 * Announce `count` new messages for `role`: replace its wake file atomically with the next `seq`,
 * under a per-role lock. Returns the new seq. A torn or malformed file is refused, because its
 * seq is unknown.
 */
export function writeWakeFile(
  layout: Layout,
  wake: { readonly role: string; readonly count: number },
): number {
  if (!ROLE.test(wake.role) || !positive(wake.count)) {
    throw new Error("wake needs a role name and a positive message count");
  }
  const path = wakeFilePath(layout, wake.role);
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  return withLock(`${path.slice(0, -".json".length)}.lock`, () => {
    const current = readWakeFile(path);
    if (current === "invalid") {
      throw new Error(`wake file is unreadable: ${path}`);
    }
    const seq = (current === "absent" ? 0 : current.seq) + 1;
    writeJsonDurable(
      path,
      Object.fromEntries([
        ["schema", 1],
        ["seq", seq],
        ["role", wake.role],
        ["count", wake.count],
      ]),
    );
    return seq;
  });
}

/** The fixed notification text of a wake. */
export function wakeText(wake: Wake): string {
  return `${wake.count} new messages for ${wake.role}: run coordination-kit inbox`;
}

/**
 * Polls one wake file and yields each seq increase once. A wake present when the channel starts
 * is announced once, because it may have been written while no channel was watching; a repeat is
 * harmless since a wake carries no payload. An absent file counts as seq 0. Several increases
 * between polls coalesce into one; a torn, malformed or unlocatable file is skipped until a later
 * poll; a lower seq is never announced.
 */
export class WakeWatcher {
  readonly #locate: () => string;
  #seen: number | undefined;

  constructor(locate: () => string) {
    this.#locate = locate;
  }

  poll(): Wake | undefined {
    let wake: ReturnType<typeof readWakeFile>;
    try {
      wake = readWakeFile(this.#locate());
    } catch {
      return undefined;
    }
    if (wake === "invalid") {
      return undefined;
    }
    if (wake === "absent") {
      this.#seen ??= 0;
      return undefined;
    }
    if (this.#seen !== undefined && wake.seq <= this.#seen) {
      return undefined;
    }
    this.#seen = wake.seq;
    return wake;
  }
}
