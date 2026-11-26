import { type Api, number, object, pages, reviewUrl, sha, text } from "./api.ts";
import {
  type CheckObservation,
  type ForgeCiState,
  ForgeError,
  type ForgeReview,
  type ForgeService,
} from "./types.ts";

function statusState(status: unknown): ForgeCiState {
  if (status === "success") {
    return "passed";
  }
  if (status === "failed" || status === "canceled" || status === "skipped") {
    return "failed";
  }
  if (
    status === "pending" ||
    status === "running" ||
    status === "created" ||
    status === "waiting_for_resource" ||
    status === "preparing" ||
    status === "manual" ||
    status === "scheduled"
  ) {
    return "pending";
  }
  return "unknown";
}

export function gitlab(api: Api, repository: string, hostname: string): ForgeService {
  const project = `projects/${encodeURIComponent(repository)}`;
  const requests = `${project}/merge_requests`;

  const parse = (payload: unknown): ForgeReview => {
    const row = object(payload);
    const { state } = row;
    if (
      number(row.source_project_id) !== number(row.target_project_id) ||
      (state !== "opened" && state !== "closed" && state !== "merged")
    ) {
      throw new ForgeError("forge-response-invalid");
    }
    const mergeSha = row.merged_commit_sha ?? row.merge_commit_sha ?? row.squash_commit_sha ?? null;
    return {
      base: text(row.target_branch),
      head: text(row.source_branch),
      headSha: sha(row.sha),
      mergeSha: state === "merged" && mergeSha !== null ? sha(mergeSha) : null,
      number: number(row.iid),
      state: state === "opened" ? "open" : state,
      url: reviewUrl(hostname, row.web_url),
    };
  };

  return {
    branchSha(branch) {
      const row = object(api(`${project}/repository/branches/${encodeURIComponent(branch)}`));
      if (row.name !== branch) {
        throw new ForgeError("forge-response-invalid");
      }
      return sha(object(row.commit).id);
    },
    checks(commit, base) {
      return pages(
        api,
        `${project}/repository/commits/${commit}/statuses`,
        base === undefined ? {} : { ref: base },
      ).map((row): CheckObservation => {
        if (row.sha !== commit || (base !== undefined && row.ref !== base)) {
          throw new ForgeError("forge-response-invalid");
        }
        return {
          family: "status",
          id: number(row.id),
          name: text(row.name),
          state: statusState(row.status),
        };
      });
    },
    create({ base, body, head, title }) {
      return parse(
        api(requests, "POST", {
          description: body,
          source_branch: head,
          target_branch: base,
          title,
        }),
      );
    },
    findOpen(head, base) {
      return pages(api, requests, {
        source_branch: head,
        state: "opened",
        target_branch: base,
      })
        .filter((row) => row.source_project_id === row.target_project_id)
        .map(parse);
    },
    merge({ headSha, number: review }) {
      api(`${requests}/${review}/merge`, "PUT", {
        sha: headSha,
        should_remove_source_branch: false,
      });
    },
    read(review) {
      return parse(api(`${requests}/${review}`));
    },
  };
}
