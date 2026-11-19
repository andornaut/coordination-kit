// One derived status per item, by documented precedence over front matter, store records,
// imported request state and delivery evidence. Pure; see docs/commands.md#status.

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

/** Front matter `done` set before this instant without deployment evidence reads as assumed. */
export const DEFAULT_VERIFY_SINCE = "2026-11-19T02:00:00Z";

export interface WorkFileEvidence {
  /** The front-matter `status` on `main`. */
  readonly frontMatter: string | null;
  /** The ID of an active work file on `main` whose `supersedes` names this item. */
  readonly supersededBy: string | null;
  readonly landed: boolean;
  readonly deployed: boolean;
  readonly channel: DeploymentChannel;
  /** A store start or a linked imported request in an active state exists. */
  readonly started: boolean;
  /** The commit that set `status: done`, else the work file's latest commit; ISO 8601. */
  readonly doneAt: string | null;
  /** `--verify-since`: done items without evidence from this instant on are unverified. */
  readonly verifySince: string;
}

export interface Derived {
  readonly status: DerivedStatus;
  readonly replacement: string | null;
  /** True with deployment evidence; false for `done` without it after the cutoff; else null. */
  readonly deliveryVerified: boolean | null;
  /** `deployed` with deployment evidence, `assumed` for `done` before the cutoff, else null. */
  readonly deliveryEvidence: "deployed" | "assumed" | null;
}

function verification(
  evidence: WorkFileEvidence,
  status: DerivedStatus,
): Pick<Derived, "deliveryEvidence" | "deliveryVerified"> {
  if (evidence.deployed) {
    return { deliveryEvidence: "deployed", deliveryVerified: true };
  }
  if (status !== "done" || evidence.channel === "none") {
    return { deliveryEvidence: null, deliveryVerified: null };
  }
  const at = evidence.doneAt === null ? Number.NaN : Date.parse(evidence.doneAt);
  return at < Date.parse(evidence.verifySince)
    ? { deliveryEvidence: "assumed", deliveryVerified: null }
    : { deliveryEvidence: null, deliveryVerified: false };
}

/**
 * Work-file items, first match wins: superseded, cancelled, declined, done (front matter `done`,
 * whatever the evidence), deployed, landed (a landing commit), in-progress (`approved` and
 * started), approved, then proposed for `proposed` or any unrecognized front-matter status.
 */
export function deriveWorkFile(evidence: WorkFileEvidence): Derived {
  const { frontMatter } = evidence;
  if (frontMatter === "superseded" || evidence.supersededBy !== null) {
    return {
      ...verification(evidence, "superseded"),
      replacement: evidence.supersededBy,
      status: "superseded",
    };
  }
  const status = ((): DerivedStatus => {
    if (frontMatter === "cancelled" || frontMatter === "declined" || frontMatter === "done") {
      return frontMatter;
    }
    if (evidence.deployed) {
      return "deployed";
    }
    if (evidence.landed) {
      return "landed";
    }
    if (frontMatter === "approved") {
      return evidence.started ? "in-progress" : "approved";
    }
    return "proposed";
  })();
  return { ...verification(evidence, status), replacement: null, status };
}

/** `--state` values: every derived status, and `unverified` for done items without evidence. */
export const STATE_FILTERS = [...DERIVED_STATUSES, "unverified"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];

/** Statuses after which an item needs nothing more. */
export const CLOSED: ReadonlySet<DerivedStatus> = new Set([
  "done",
  "declined",
  "cancelled",
  "superseded",
]);

/** Imported request states that count an approved item as started. */
export const ACTIVE_LEDGER_STATES: ReadonlySet<string> = new Set([
  "started",
  "blocked",
  "waiting",
  "ready",
  "checked",
  "integrated",
  "delivered",
]);
