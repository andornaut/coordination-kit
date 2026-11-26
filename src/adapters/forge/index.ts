import { cliApi, isSha, positiveInteger, runForge } from "./api.ts";
import { github } from "./github.ts";
import { gitlab } from "./gitlab.ts";
import {
  type CheckObservation,
  type ForgeAdapter,
  type ForgeCiState,
  ForgeError,
  type ForgeHead,
  type ForgeReview,
  type ForgeRunner,
  type ForgeTarget,
} from "./types.ts";

export type {
  ForgeAdapter,
  ForgeCi,
  ForgeCiState,
  ForgeCreate,
  ForgeFailure,
  ForgeHead,
  ForgeMerge,
  ForgeProvider,
  ForgeReview,
  ForgeRunner,
  ForgeTarget,
  GitHubMergeMethod,
} from "./types.ts";
export { ForgeError } from "./types.ts";

function hostname(target: ForgeTarget): string {
  const { mergeMethod, provider, repository, requiredChecks } = target;
  if (provider !== "github" && provider !== "gitlab") {
    throw new ForgeError("forge-target-invalid");
  }
  const parts = repository.split("/");
  const host = target.hostname ?? (provider === "github" ? "github.com" : "gitlab.com");
  const parsed = URL.parse(`https://${host}`);
  if (
    parts.length < 2 ||
    (provider === "github" && parts.length !== 2) ||
    parts.some((part) => !/^[a-z0-9_.-]+$/i.test(part) || part === "." || part === "..") ||
    !/^[a-z0-9.-]+(?::[0-9]+)?$/i.test(host) ||
    parsed === null ||
    (mergeMethod !== undefined &&
      (provider !== "github" || !["merge", "squash", "rebase"].includes(mergeMethod))) ||
    requiredChecks.some((name) => name.trim() === "" || name !== name.trim()) ||
    new Set(requiredChecks).size !== requiredChecks.length
  ) {
    throw new ForgeError("forge-target-invalid");
  }
  return parsed.host;
}

function sameHead(review: ForgeReview, expected: ForgeHead): boolean {
  return (
    review.head === expected.head &&
    review.base === expected.base &&
    review.headSha === expected.headSha
  );
}

function branchValid(branch: string): boolean {
  return branch.length > 0 && branch.trim() === branch && !branch.includes("\0");
}

function conclusion(states: readonly ForgeCiState[]): ForgeCiState {
  if (states.includes("failed")) {
    return "failed";
  }
  if (states.includes("unknown")) {
    return "unknown";
  }
  if (states.includes("pending") || states.length === 0) {
    return "pending";
  }
  return "passed";
}

function requiredState(name: string, observations: readonly CheckObservation[]): ForgeCiState {
  const latest = new Map<CheckObservation["family"], CheckObservation>();
  for (const observation of observations) {
    if (observation.name === name && observation.id > (latest.get(observation.family)?.id ?? 0)) {
      latest.set(observation.family, observation);
    }
  }
  return conclusion([...latest.values()].map((observation) => observation.state));
}

export function createForge(target: ForgeTarget, run: ForgeRunner = runForge): ForgeAdapter {
  const host = hostname(target);
  const command = target.provider === "github" ? "gh" : "glab";
  const api = cliApi(command, host, run);
  const service =
    target.provider === "github"
      ? github(api, target.repository, host, target.mergeMethod)
      : gitlab(api, target.repository, host);

  function read(number: number): ForgeReview {
    if (!positiveInteger(number)) {
      throw new ForgeError("forge-input-invalid");
    }
    const review = service.read(number);
    if (review.number !== number) {
      throw new ForgeError("forge-review-mismatch");
    }
    return review;
  }

  function existingOpen(expected: ForgeHead): ForgeReview | undefined {
    const existing = service.findOpen(expected.head, expected.base);
    if (existing.length === 0) {
      return undefined;
    }
    if (
      existing.length !== 1 ||
      existing[0]?.state !== "open" ||
      !sameHead(existing[0], expected)
    ) {
      throw new ForgeError("forge-review-mismatch");
    }
    return existing[0];
  }

  return {
    create(input) {
      if (
        !isSha(input.headSha) ||
        !branchValid(input.head) ||
        !branchValid(input.base) ||
        input.head === input.base ||
        input.title.trim() === ""
      ) {
        throw new ForgeError("forge-input-invalid");
      }
      if (service.branchSha(input.head) !== input.headSha) {
        throw new ForgeError("forge-head-mismatch");
      }
      const previous = existingOpen(input);
      if (previous !== undefined) {
        return previous;
      }
      let review;
      try {
        review = service.create(input);
      } catch {
        // The forge may have processed the request before the client lost its response.
        try {
          const observed = existingOpen(input);
          if (observed !== undefined) {
            return observed;
          }
        } catch {
          // No exact review was proved by readback.
        }
        throw new ForgeError("forge-create-unconfirmed");
      }
      if (review.state !== "open" || !sameHead(review, input)) {
        throw new ForgeError("forge-review-mismatch");
      }
      return review;
    },
    merge(input) {
      if (!isSha(input.headSha) || (input.base !== undefined && !branchValid(input.base))) {
        throw new ForgeError("forge-input-invalid");
      }
      const matches = (review: ForgeReview) =>
        review.headSha === input.headSha &&
        (input.base === undefined || review.base === input.base);
      const current = read(input.number);
      if (!matches(current) || current.state === "closed") {
        throw new ForgeError("forge-review-mismatch");
      }
      if (current.state === "merged" && current.mergeSha !== null) {
        return current;
      }
      if (current.state === "open") {
        try {
          service.merge(input);
        } catch {
          // Confirm both success and ambiguous transport failure from the forge's review.
        }
      }
      try {
        const merged = read(input.number);
        if (matches(merged) && merged.state === "merged" && merged.mergeSha !== null) {
          return merged;
        }
      } catch {
        // Without the exact merge commit, the outcome is unconfirmed.
      }
      throw new ForgeError("forge-merge-unconfirmed");
    },
    read,
    verifyCi(commit, base) {
      if (!isSha(commit) || (base !== undefined && !branchValid(base))) {
        throw new ForgeError("forge-input-invalid");
      }
      const names = target.requiredChecks;
      if (names.length === 0) {
        return { checks: [], sha: commit, state: "unknown" };
      }
      try {
        const observations = service.checks(commit, base);
        const checks = names.map((name) => ({ name, state: requiredState(name, observations) }));
        return { checks, sha: commit, state: conclusion(checks.map((check) => check.state)) };
      } catch {
        return {
          checks: names.map((name) => ({ name, state: "unknown" })),
          sha: commit,
          state: "unknown",
        };
      }
    },
  };
}
