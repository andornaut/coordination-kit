// One derived status per item, by documented precedence over front matter, ledger state, protocol
// state and delivery evidence. Pure; see docs/commands.md#status.
import type { LedgerState } from "../accounting/types.ts";

export const DERIVED_STATUSES = [
  "requested",
  "proposed",
  "approved",
  "in-progress",
  "landed",
  "deployed",
  "done",
  "declined",
  "cancelled",
  "superseded",
] as const;
export type DerivedStatus = (typeof DERIVED_STATUSES)[number];

/** How a repository deploys: runner COMPLETE events (games), release tags (kits) or not at all. */
export type DeploymentChannel = "bus" | "release-tag" | "none";

export interface WorkFileEvidence {
  /** The front-matter `status` on `main`. */
  readonly frontMatter: string | null;
  /** The ID of an active work file on `main` whose `supersedes` names this item. */
  readonly supersededBy: string | null;
  readonly landed: boolean;
  readonly deployed: boolean;
  readonly channel: DeploymentChannel;
  /** A work publication, worker submission or linked ledger request in an active state exists. */
  readonly started: boolean;
}

export interface Derived {
  readonly status: DerivedStatus;
  readonly replacement: string | null;
}

/**
 * Work-file items, first match wins: superseded, cancelled, declined, done (front matter `done`
 * and deployed, or `done` in a repository without a deployment channel), deployed, landed (a
 * landing commit, or front matter `done`), in-progress (`approved` and started), approved, then
 * proposed for `proposed` or any unrecognized front-matter status.
 */
export function deriveWorkFile(evidence: WorkFileEvidence): Derived {
  const { frontMatter } = evidence;
  if (frontMatter === "superseded" || evidence.supersededBy !== null) {
    return { replacement: evidence.supersededBy, status: "superseded" };
  }
  const status = ((): DerivedStatus => {
    if (frontMatter === "cancelled" || frontMatter === "declined") {
      return frontMatter;
    }
    if (frontMatter === "done" && (evidence.deployed || evidence.channel === "none")) {
      return "done";
    }
    if (evidence.deployed) {
      return "deployed";
    }
    if (evidence.landed || frontMatter === "done") {
      return "landed";
    }
    if (frontMatter === "approved") {
      return evidence.started ? "in-progress" : "approved";
    }
    return "proposed";
  })();
  return { replacement: null, status };
}

/**
 * Ledger requests with no work file: superseded (with the ledger's replacement), cancelled, done
 * for `completed`, otherwise requested.
 */
export function deriveLedgerOnly(state: LedgerState, replacementId: string | null): Derived {
  if (state === "superseded") {
    return { replacement: replacementId, status: "superseded" };
  }
  if (state === "cancelled") {
    return { replacement: null, status: "cancelled" };
  }
  return { replacement: null, status: state === "completed" ? "done" : "requested" };
}

/** Statuses after which an item needs nothing more. */
export const CLOSED: ReadonlySet<DerivedStatus> = new Set([
  "done",
  "declined",
  "cancelled",
  "superseded",
]);

export const ACTIVE_LEDGER_STATES: ReadonlySet<LedgerState> = new Set([
  "started",
  "blocked",
  "waiting",
  "ready",
  "checked",
  "integrated",
  "delivered",
]);
