// Drive the bus event outbox through the built public seam, as delivery-kit's runner reaches it:
// a producer pass records events with `recordEvent`, and each observer pass ends with
// `flushEvents`. Every pass is a fresh process, so a later pass is a restart that keeps only
// durable state.
import { createHash } from "node:crypto";

import { execute, impl, type RecordedEvent, type Result } from "./adapter.ts";
import { sleep } from "./time.ts";
import type { Workspace } from "./workspace.ts";

/** The outbox identity of an event kind and key; every blocked-* kind shares one identity. */
export function eventId(kind: string, key: string): string {
  const identity = kind.startsWith("blocked-") ? "blocked" : kind;
  return createHash("sha256").update(`${identity}:${key}`, "utf8").digest("hex");
}

function checked(result: Result, what: string): Result {
  if (result.code !== 0) {
    throw new Error(
      `${what} exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

/** Record `events` in order in one producer pass. */
export async function record(ws: Workspace, ...events: RecordedEvent[]): Promise<void> {
  checked(await execute(impl.record(ws, events)), "event record pass");
}

/** Run `count` flush passes in sequence and return their combined output. */
export async function flush(ws: Workspace, count = 1): Promise<string> {
  let output = "";
  for (let pass = 0; pass < count; pass += 1) {
    const result = checked(await execute(impl.flush(ws)), "event flush pass");
    output += result.stdout + result.stderr;
  }
  return output;
}

/** Flush until `predicate` holds, as successive observer passes do while a consumer runs. */
export async function flushUntil(
  ws: Workspace,
  predicate: () => boolean,
  limit = 200,
): Promise<void> {
  for (let pass = 0; !predicate(); pass += 1) {
    if (pass >= limit) throw new Error(`condition did not hold after ${limit} flush passes`);
    await flush(ws);
    await sleep(50);
  }
}

/**
 * Clear an event's sent flag in place, as an outbox write lost after native acceptance leaves it.
 * The text is edited directly so the nanosecond `created` keeps its exact digits.
 */
export function unsend(ws: Workspace, id: string): void {
  const name = `events/${id}.json`;
  ws.write(name, ws.read(name).replace('"sent": true', '"sent": false'));
}

/** Whether the outbox entry `id` is marked sent. */
export function sent(ws: Workspace, id: string): boolean {
  return ws.exists(`events/${id}.json`) && ws.readJson(`events/${id}.json`).sent === true;
}
