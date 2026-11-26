export type ForgeProvider = "github" | "gitlab";
export type GitHubMergeMethod = "merge" | "squash" | "rebase";

export interface ForgeTarget {
  readonly provider: ForgeProvider;
  readonly repository: string;
  readonly hostname?: string;
  readonly mergeMethod?: GitHubMergeMethod;
  readonly requiredChecks: readonly string[];
}

export type ForgeRunner = (
  command: "gh" | "glab",
  args: readonly string[],
  input?: string,
) => string;

export interface ForgeHead {
  readonly head: string;
  readonly base: string;
  readonly headSha: string;
}

export interface ForgeCreate extends ForgeHead {
  readonly title: string;
  readonly body: string;
}

export interface ForgeReview extends ForgeHead {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly mergeSha: string | null;
}

export interface ForgeMerge {
  readonly number: number;
  readonly headSha: string;
  readonly base?: string;
}

export type ForgeCiState = "passed" | "pending" | "failed" | "unknown";

export interface ForgeCi {
  readonly sha: string;
  readonly state: ForgeCiState;
  readonly checks: readonly { readonly name: string; readonly state: ForgeCiState }[];
}

export interface ForgeAdapter {
  /** Call only after the user explicitly requests creation for the pushed head. */
  create(input: ForgeCreate): ForgeReview;
  read(number: number): ForgeReview;
  /** Call only after exact approval for this review and head. */
  merge(input: ForgeMerge): ForgeReview;
  verifyCi(sha: string, base?: string): ForgeCi;
}

export type ForgeFailure =
  | "forge-target-invalid"
  | "forge-input-invalid"
  | "forge-cli-unavailable"
  | "forge-request-failed"
  | "forge-response-invalid"
  | "forge-review-mismatch"
  | "forge-head-mismatch"
  | "forge-create-unconfirmed"
  | "forge-merge-unconfirmed";

export class ForgeError extends Error {
  readonly code: ForgeFailure;

  constructor(code: ForgeFailure) {
    super(code);
    this.code = code;
  }
}

export interface CheckObservation {
  readonly id: number;
  readonly name: string;
  readonly family: "run" | "status";
  readonly state: ForgeCiState;
}

export interface ForgeService {
  branchSha(branch: string): string;
  findOpen(head: string, base: string): readonly ForgeReview[];
  create(input: ForgeCreate): ForgeReview;
  read(number: number): ForgeReview;
  merge(input: ForgeMerge): void;
  checks(sha: string, base?: string): readonly CheckObservation[];
}
