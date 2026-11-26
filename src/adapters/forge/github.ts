import { type Api, number, object, pages, reviewUrl, sha, text } from "./api.ts";
import {
  type CheckObservation,
  type ForgeCiState,
  ForgeError,
  type ForgeReview,
  type ForgeService,
  type GitHubMergeMethod,
} from "./types.ts";

function sameRepository(repository: string, ref: unknown): boolean {
  const { repo } = object(ref);
  return repo !== null && text(object(repo).full_name).toLowerCase() === repository.toLowerCase();
}

function runState(status: unknown, conclusion: unknown): ForgeCiState {
  if (status === "completed") {
    if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") {
      return "passed";
    }
    return typeof conclusion === "string" ? "failed" : "unknown";
  }
  return status === "queued" || status === "in_progress" || status === "waiting"
    ? "pending"
    : "unknown";
}

function statusState(state: unknown): ForgeCiState {
  if (state === "success") {
    return "passed";
  }
  if (state === "error" || state === "failure") {
    return "failed";
  }
  return state === "pending" ? "pending" : "unknown";
}

export function github(
  api: Api,
  repository: string,
  hostname: string,
  mergeMethod?: GitHubMergeMethod,
): ForgeService {
  const project = `repos/${repository}`;
  const pulls = `${project}/pulls`;
  const [owner] = repository.split("/");

  const parse = (payload: unknown): ForgeReview => {
    const row = object(payload);
    const { merged, state } = row;
    if (
      !sameRepository(repository, row.head) ||
      !sameRepository(repository, row.base) ||
      (state !== "open" && (state !== "closed" || typeof merged !== "boolean")) ||
      (state === "open" && merged === true)
    ) {
      throw new ForgeError("forge-response-invalid");
    }
    const head = object(row.head);
    return {
      base: text(object(row.base).ref),
      head: text(head.ref),
      headSha: sha(head.sha),
      mergeSha: merged === true && row.merge_commit_sha !== null ? sha(row.merge_commit_sha) : null,
      number: number(row.number),
      state: merged === true ? "merged" : state,
      url: reviewUrl(hostname, row.html_url),
    };
  };

  return {
    branchSha(branch) {
      const row = object(api(`${project}/branches/${encodeURIComponent(branch)}`));
      if (row.name !== branch) {
        throw new ForgeError("forge-response-invalid");
      }
      return sha(object(row.commit).sha);
    },
    checks(commit) {
      const commitPath = `${project}/commits/${commit}`;
      const checkRuns = pages(
        api,
        `${commitPath}/check-runs`,
        { filter: "all" },
        (payload) => object(payload).check_runs,
      ).map((row): CheckObservation => {
        if (row.head_sha !== commit) {
          throw new ForgeError("forge-response-invalid");
        }
        return {
          family: "run",
          id: number(row.id),
          name: text(row.name),
          state: runState(row.status, row.conclusion),
        };
      });
      const statuses = pages(api, `${commitPath}/status`, {}, (payload) => {
        const row = object(payload);
        if (row.sha !== commit) {
          throw new ForgeError("forge-response-invalid");
        }
        return row.statuses;
      }).map((row): CheckObservation => ({
        family: "status",
        id: number(row.id),
        name: text(row.context),
        state: statusState(row.state),
      }));
      return [...checkRuns, ...statuses];
    },
    create({ base, body, head, title }) {
      return parse(api(pulls, "POST", { base, body, head, title }));
    },
    findOpen(head, base) {
      return pages(api, pulls, { base, head: `${owner}:${head}`, state: "open" })
        .filter((row) => sameRepository(repository, row.head))
        .map(parse);
    },
    merge({ headSha, number: review }) {
      api(`${pulls}/${review}/merge`, "PUT", {
        sha: headSha,
        ...(mergeMethod === undefined ? {} : { merge_method: mergeMethod }),
      });
    },
    read(review) {
      return parse(api(`${pulls}/${review}`));
    },
  };
}
