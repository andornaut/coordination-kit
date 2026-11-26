// Typed seam outcomes for delivery-kit's runner: the status and the fixed reason tokens. The runner
// reads only `status` and `reason`; `detail` is free text for its log.

/** Every reason a typed seam result may carry, lowercase and fixed. */
export const REASON_TOKENS = [
  "route-unavailable",
  "recipient-unavailable",
  "recipient-busy",
  "question-pending",
  "held",
  "receipt-ambiguous",
  "already-delivered",
  "nothing-due",
  "no-events",
  "cli-error",
  "outbox-unreadable",
  "in-flight",
  "compaction-reserved",
] as const;

export type ReasonToken = (typeof REASON_TOKENS)[number];

export type SeamStatus = "delivered" | "deferred" | "skipped";

/** The schema-1 selector echoed by a runner seam. */
export type RunnerIdField = "appId" | "game";

/** One slot's typed `review deliver` result. */
export interface ReviewResult {
  readonly status: SeamStatus;
  readonly reason: ReasonToken | null;
  readonly detail: string;
}

/** The running CLI's identity: its package version and the sha256 of its dist/cli.js bytes. */
export interface CliIdentity {
  readonly version: string;
  readonly distSha256: string;
}

/** The ordered `cli` member of every typed result. */
export function cliMember(cli: CliIdentity): Record<string, string> {
  return Object.fromEntries([
    ["version", cli.version],
    ["distSha256", cli.distSha256],
  ]);
}
