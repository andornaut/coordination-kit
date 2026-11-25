// Typed seam outcomes for delivery-kit's runner: the status, the fixed reason tokens and how each
// existing review and event result maps onto them. The runner reads only `status` and `reason`;
// `detail` is free text for its log.

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

const ROUTE =
  /\broute\b|worker ?parents|workerParents|endpoint harness|requires the Claude harness/i;
const QUESTION = /question|answer|decision|clearance|resolution|approval/i;
const BUSY = /blocked|busy|ambiguous or interrupted/i;

/**
 * The reason token for a result that did not deliver: its receipt status first, then the first
 * matching rule over its reason text. Any other text names an unreachable recipient.
 */
export function reasonToken(status: string, reason?: string | null): ReasonToken {
  if (status === "ambiguous") {
    return "receipt-ambiguous";
  }
  if (status === "sending") {
    return "in-flight";
  }
  if (status === "busy") {
    return "recipient-busy";
  }
  const text = reason ?? "";
  if (text.includes("do not resend")) {
    return "receipt-ambiguous";
  }
  if (ROUTE.test(text)) {
    return "route-unavailable";
  }
  if (QUESTION.test(text)) {
    return "question-pending";
  }
  if (BUSY.test(text)) {
    return "recipient-busy";
  }
  return "recipient-unavailable";
}
