// `review deliver`: one typed result per (game, slot) for delivery-kit's runner. The brief is one
// stored message per (game, slot); natives only wake. The result is recorded, so a repeated call
// for the slot returns the recorded result without composing the brief again.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { isRecord } from "../adapters/shared/pyjson.ts";
import { readJsonIfExists, writeJsonDurable } from "../durable.ts";
import type { GameLayout, Layout } from "../layout.ts";
import { holdLock, LockBusy, type LockHandle } from "../lock.ts";
import type { WakePorts } from "../store/wake.ts";
import {
  type CliIdentity,
  cliMember,
  REASON_TOKENS,
  type ReasonToken,
  type ReviewResult,
  type SeamStatus,
} from "./outcome.ts";
import { storeReview } from "./storeBrief.ts";
import type { NativeCollect } from "./storeNative.ts";

export interface ReviewOptions {
  /** The environment and wake ports for the brief's wakes, and the store clock. */
  readonly env?: NodeJS.ProcessEnv;
  readonly wakePorts?: WakePorts;
  readonly now?: () => string;
  /** Test hook: replaces the native connection and collectors. */
  readonly collect?: NativeCollect;
}

const STATUSES: ReadonlySet<string> = new Set(["delivered", "deferred", "skipped"]);

/** `<bus>/unblock/review-deliver/`: one recorded result per slot and the per-game call lock. */
export function reviewResultsDir(game: GameLayout): string {
  return join(game.busDir, "unblock", "review-deliver");
}

function recordPath(game: GameLayout, slot: number): string {
  return join(reviewResultsDir(game), `${slot}.json`);
}

function recorded(game: GameLayout, slot: number): ReviewResult | undefined {
  const value = readJsonIfExists(recordPath(game, slot));
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    value.kind !== "review-deliver" ||
    value.game !== game.id ||
    value.slot !== slot ||
    typeof value.status !== "string" ||
    !STATUSES.has(value.status) ||
    !(value.reason === null || (REASON_TOKENS as readonly unknown[]).includes(value.reason)) ||
    typeof value.detail !== "string"
  ) {
    throw new Error(`recorded review result is invalid: ${recordPath(game, slot)}`);
  }
  return {
    detail: value.detail,
    reason: value.reason as ReasonToken | null,
    status: value.status as SeamStatus,
  };
}

function record(game: GameLayout, slot: number, result: ReviewResult): void {
  writeJsonDurable(recordPath(game, slot), {
    detail: result.detail,
    game: game.id,
    kind: "review-deliver",
    reason: result.reason,
    schema: 1,
    slot,
    status: result.status,
  });
}

const CALL_BUSY: ReviewResult = {
  detail: "another review deliver for this game holds its lock",
  reason: "recipient-busy",
  status: "deferred",
};

/**
 * Deliver the scheduled review for `slot` (epoch seconds) once. A recorded result for the slot is
 * returned as recorded; otherwise the brief is stored and its result recorded, except for lock
 * contention. Undefined when `signal` stopped the call before it began: nothing is recorded.
 */
export async function deliverReview(
  layout: Layout,
  game: GameLayout,
  slot: number,
  signal?: AbortSignal,
  options: ReviewOptions = {},
): Promise<ReviewResult | undefined> {
  mkdirSync(reviewResultsDir(game), { recursive: true });
  let lock: LockHandle;
  try {
    lock = holdLock(join(reviewResultsDir(game), "deliver.lock"), { nonBlocking: true });
  } catch (error) {
    if (error instanceof LockBusy) {
      return CALL_BUSY;
    }
    throw error;
  }
  try {
    const previous = recorded(game, slot);
    if (previous !== undefined) {
      return previous;
    }
    if (signal?.aborted === true) {
      return undefined;
    }
    const stored = await storeReview(
      {
        env: options.env ?? process.env,
        layout,
        ...(options.wakePorts === undefined ? {} : { ports: options.wakePorts }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.collect === undefined ? {} : { collect: options.collect }),
      },
      game,
      slot,
    );
    record(game, slot, stored);
    return stored;
  } finally {
    lock.release();
  }
}

/** The one stdout line of `review deliver`, in its documented key order. */
export function reviewDeliverLine(
  cli: CliIdentity,
  game: string,
  slot: string,
  result: ReviewResult,
): string {
  return `${JSON.stringify(
    Object.fromEntries([
      ["schema", 1],
      ["kind", "review-deliver"],
      ["game", game],
      ["slot", slot],
      ["status", result.status],
      ["reason", result.reason],
      ["detail", result.detail],
      ["cli", cliMember(cli)],
    ]),
  )}\n`;
}
