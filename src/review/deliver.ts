// `review deliver`: one typed result per (game, slot) for delivery-kit's runner. The scheduled
// review seam keeps its own slot receipts, deduplication, ambiguity and stale-turn rules; this
// module maps its outcome to a status and reason token and records the result, so a repeated call
// for the slot returns the recorded result without calling the seam again.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { unblockDir } from "../adapters/claude/spool.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import { readJsonIfExists, writeJsonDurable } from "../durable.ts";
import type { GameLayout, Layout } from "../layout.ts";
import { holdLock, LockBusy, type LockHandle } from "../lock.ts";
import {
  type CliIdentity,
  cliMember,
  REASON_TOKENS,
  type ReasonToken,
  reasonToken,
  type SeamStatus,
} from "./outcome.ts";
import { outcomeLine, type ReviewOptions, type ReviewOutcome, reviewOutcome } from "./wake.ts";

export interface ReviewResult {
  readonly status: SeamStatus;
  readonly reason: ReasonToken | null;
  readonly detail: string;
}

interface Mapped {
  readonly result: ReviewResult;
  /** False for lock contention, which the seam itself never records either. */
  readonly record: boolean;
}

const DELIVERED_STATUSES: ReadonlySet<string> = new Set(["accepted", "sending"]);
const STATUSES: ReadonlySet<string> = new Set(["delivered", "deferred", "skipped"]);

/** The typed result of one seam outcome; undefined when a stop interrupted a native send. */
export function mapReviewOutcome(outcome: ReviewOutcome): Mapped | undefined {
  switch (outcome.kind) {
    case "interrupted":
      return undefined;
    case "skip":
      return {
        record: true,
        result: { detail: outcome.detail, reason: outcome.reason, status: "skipped" },
      };
    case "deferred":
      return {
        record: true,
        result: {
          detail: outcome.text,
          reason: reasonToken("deferred", outcome.text),
          status: "deferred",
        },
      };
    default: {
      const { state } = outcome;
      const detail = outcomeLine(outcome);
      const status = String(state.status);
      const reason = typeof state.reason === "string" ? state.reason : null;
      if (DELIVERED_STATUSES.has(status)) {
        return { record: true, result: { detail, reason: null, status: "delivered" } };
      }
      if (status === "deduplicated") {
        const previous = String(state.previousStatus);
        return {
          record: true,
          result: {
            detail,
            reason: DELIVERED_STATUSES.has(previous)
              ? "already-delivered"
              : reasonToken(previous, reason),
            status: "skipped",
          },
        };
      }
      return {
        record: status !== "busy",
        result: { detail, reason: reasonToken(status, reason), status: "deferred" },
      };
    }
  }
}

/** `<bus>/unblock/review-deliver/`: one recorded result per slot and the per-game call lock. */
export function reviewResultsDir(game: GameLayout): string {
  return join(unblockDir(game.busDir), "review-deliver");
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
 * returned as recorded; otherwise the seam runs and its result is recorded, except for lock
 * contention. Undefined when `signal` stopped the call before a result: nothing is recorded and
 * the seam's receipt stays as the stop left it.
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
    const mapped = mapReviewOutcome(await reviewOutcome(layout, game, slot, signal, options));
    if (mapped === undefined) {
      return undefined;
    }
    if (mapped.record) {
      record(game, slot, mapped.result);
    }
    return mapped.result;
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
