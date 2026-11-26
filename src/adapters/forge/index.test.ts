import { describe, expect, it, vi } from "vitest";

import { createForge, type ForgeRunner } from "./index.ts";

const hostname = "forge.example.invalid";
const repository = "owners/project";
const branch = "review/example";
const base = "main";
const headSha = "a".repeat(40);
const mergeSha = "b".repeat(40);
const otherSha = "c".repeat(40);
const input = { base, body: "User-approved draft", head: branch, headSha, title: "Review changes" };

function githubReview(merged = false, head = headSha) {
  return {
    base: { ref: base, repo: { full_name: repository } },
    head: { ref: branch, repo: { full_name: repository }, sha: head },
    html_url: `https://${hostname}/${repository}/pull/8`,
    merge_commit_sha: mergeSha,
    merged,
    number: 8,
    state: merged ? "closed" : "open",
  };
}

function gitlabReview(merged = false, head = headSha) {
  return {
    iid: 8,
    merge_commit_sha: merged ? mergeSha : null,
    sha: head,
    source_branch: branch,
    source_project_id: 10,
    state: merged ? "merged" : "opened",
    target_branch: base,
    target_project_id: 10,
    web_url: `https://${hostname}/${repository}/-/merge_requests/8`,
  };
}

const cases = [
  {
    branchPath: "repos/owners/project/branches/review%2Fexample",
    branchResponse: (commit = headSha) => ({ commit: { sha: commit }, name: branch }),
    command: "gh",
    createBody: { base, body: input.body, head: branch, title: input.title },
    mergeBody: { sha: headSha },
    provider: "github",
    reviews: "repos/owners/project/pulls",
    response: githubReview,
    query: "base=main&head=owners%3Areview%2Fexample&state=open",
  },
  {
    branchPath: "projects/owners%2Fproject/repository/branches/review%2Fexample",
    branchResponse: (commit = headSha) => ({ commit: { id: commit }, name: branch }),
    command: "glab",
    createBody: {
      description: input.body,
      source_branch: branch,
      target_branch: base,
      title: input.title,
    },
    mergeBody: { sha: headSha, should_remove_source_branch: false },
    provider: "gitlab",
    reviews: "projects/owners%2Fproject/merge_requests",
    response: gitlabReview,
    query: "source_branch=review%2Fexample&state=opened&target_branch=main",
  },
] as const;

function argumentsFor(method: string, endpoint: string, input = false): string[] {
  return [
    "api",
    "--hostname",
    hostname,
    "--method",
    method,
    endpoint,
    ...(input ? ["--input", "-"] : []),
  ];
}

describe.each(cases)("$provider review adapter", (fixture) => {
  const target = { hostname, provider: fixture.provider, repository, requiredChecks: [] };

  it("creates exactly one review for the current pushed head", () => {
    const runner = vi
      .fn<ForgeRunner>()
      .mockReturnValueOnce(JSON.stringify(fixture.branchResponse()))
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce(JSON.stringify(fixture.response()));
    expect(createForge(target, runner).create(input)).toMatchObject({
      base,
      head: branch,
      headSha,
      mergeSha: null,
      number: 8,
      state: "open",
    });
    expect(runner.mock.calls).toEqual([
      [fixture.command, argumentsFor("GET", fixture.branchPath), undefined],
      [
        fixture.command,
        argumentsFor("GET", `${fixture.reviews}?${fixture.query}&page=1&per_page=100`),
        undefined,
      ],
      [
        fixture.command,
        argumentsFor("POST", fixture.reviews, true),
        JSON.stringify(fixture.createBody),
      ],
    ]);
  });

  it("reuses an existing exact review and refuses an unrelated head", () => {
    const runner = vi
      .fn<ForgeRunner>()
      .mockReturnValueOnce(JSON.stringify(fixture.branchResponse()))
      .mockReturnValueOnce(JSON.stringify([fixture.response()]))
      .mockReturnValueOnce(JSON.stringify(fixture.branchResponse(otherSha)));
    const forge = createForge(target, runner);
    expect(forge.create(input).number).toBe(8);
    expect(() => forge.create(input)).toThrow("forge-head-mismatch");
    expect(runner.mock.calls.map(([, args]) => args[4])).toEqual(["GET", "GET", "GET"]);
  });

  it("reconciles ambiguous creation through exact readback without repeating the POST", () => {
    const runner = vi
      .fn<ForgeRunner>()
      .mockReturnValueOnce(JSON.stringify(fixture.branchResponse()))
      .mockReturnValueOnce("[]")
      .mockImplementationOnce(() => {
        throw new Error("untrusted diagnostic");
      })
      .mockReturnValueOnce(JSON.stringify([fixture.response()]));
    expect(createForge(target, runner).create(input).number).toBe(8);
    expect(runner.mock.calls.map(([, args]) => args[4])).toEqual(["GET", "GET", "POST", "GET"]);
  });

  it("does not report creation when readback cannot prove the expected head", () => {
    const runner = vi
      .fn<ForgeRunner>()
      .mockReturnValueOnce(JSON.stringify(fixture.branchResponse()))
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce("malformed")
      .mockReturnValueOnce(JSON.stringify([fixture.response(false, otherSha)]));
    expect(() => createForge(target, runner).create(input)).toThrow(/^forge-create-unconfirmed$/);
    expect(runner.mock.calls.map(([, args]) => args[4])).toEqual(["GET", "GET", "POST", "GET"]);
  });

  it("obtains the exact merge commit from the forge after the SHA-gated merge", () => {
    const runner = vi
      .fn<ForgeRunner>()
      .mockReturnValueOnce(JSON.stringify(fixture.response()))
      .mockReturnValueOnce("{}")
      .mockReturnValueOnce(JSON.stringify(fixture.response(true)));
    expect(createForge(target, runner).merge({ base, headSha, number: 8 })).toMatchObject({
      mergeSha,
      state: "merged",
    });
    expect(runner.mock.calls).toEqual([
      [fixture.command, argumentsFor("GET", `${fixture.reviews}/8`), undefined],
      [
        fixture.command,
        argumentsFor("PUT", `${fixture.reviews}/8/merge`, true),
        JSON.stringify(fixture.mergeBody),
      ],
      [fixture.command, argumentsFor("GET", `${fixture.reviews}/8`), undefined],
    ]);
  });

  it("reads a manually merged review and declines to merge an unexpected head or base", () => {
    const runner = vi
      .fn<ForgeRunner>()
      .mockReturnValueOnce(JSON.stringify(fixture.response(true)))
      .mockReturnValueOnce(JSON.stringify(fixture.response(false, otherSha)))
      .mockReturnValueOnce(JSON.stringify(fixture.response()));
    const forge = createForge(target, runner);
    expect(forge.read(8)).toMatchObject({ headSha, mergeSha, state: "merged" });
    expect(() => forge.merge({ base, headSha, number: 8 })).toThrow("forge-review-mismatch");
    expect(() => forge.merge({ base: "another-base", headSha, number: 8 })).toThrow(
      "forge-review-mismatch",
    );
    expect(runner.mock.calls.map(([, args]) => args[4])).toEqual(["GET", "GET", "GET"]);
  });
});

describe("exact-commit CI verification", () => {
  const checks = { hostname, repository, requiredChecks: ["build", "lint"] };

  it("reports GitLab's merged commit SHA even when there was no merge commit", () => {
    const response = { ...gitlabReview(true), merge_commit_sha: null, merged_commit_sha: headSha };
    const runner = vi.fn<ForgeRunner>().mockReturnValue(JSON.stringify(response));
    const forge = createForge({ ...checks, provider: "gitlab" }, runner);
    expect(forge.read(8)).toMatchObject({ headSha, mergeSha: headSha, state: "merged" });
  });

  it("uses the latest GitHub run and also requires a same-name commit status", () => {
    const runner = vi
      .fn<ForgeRunner>()
      .mockReturnValueOnce(
        JSON.stringify({
          check_runs: [
            {
              conclusion: "success",
              head_sha: mergeSha,
              id: 5,
              name: "build",
              status: "completed",
            },
            {
              conclusion: "success",
              head_sha: mergeSha,
              id: 6,
              name: "build",
              status: "in_progress",
            },
            { conclusion: "neutral", head_sha: mergeSha, id: 9, name: "lint", status: "completed" },
          ],
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          sha: mergeSha,
          statuses: [{ context: "lint", id: 15, state: "failure" }],
        }),
      );
    const forge = createForge({ ...checks, provider: "github" }, runner);
    expect(forge.verifyCi(mergeSha, base)).toEqual({
      checks: [
        { name: "build", state: "pending" },
        { name: "lint", state: "failed" },
      ],
      sha: mergeSha,
      state: "failed",
    });
    expect(runner.mock.calls[0]?.[1][5]).toBe(
      `repos/${repository}/commits/${mergeSha}/check-runs?filter=all&page=1&per_page=100`,
    );
    expect(runner.mock.calls[1]?.[1][5]).toBe(
      `repos/${repository}/commits/${mergeSha}/status?page=1&per_page=100`,
    );
  });

  it("checks GitLab statuses for the named target branch and exact merge commit", () => {
    const runner = vi.fn<ForgeRunner>().mockReturnValue(
      JSON.stringify([
        { id: 4, name: "build", ref: base, sha: mergeSha, status: "failed" },
        { id: 5, name: "build", ref: base, sha: mergeSha, status: "success" },
        { id: 6, name: "lint", ref: base, sha: mergeSha, status: "success" },
      ]),
    );
    const forge = createForge({ ...checks, provider: "gitlab" }, runner);
    expect(forge.verifyCi(mergeSha, base)).toEqual({
      checks: [
        { name: "build", state: "passed" },
        { name: "lint", state: "passed" },
      ],
      sha: mergeSha,
      state: "passed",
    });
    expect(runner.mock.calls[0]?.[1][5]).toBe(
      `projects/owners%2Fproject/repository/commits/${mergeSha}/statuses?ref=main&page=1&per_page=100`,
    );
  });

  it("keeps missing checks pending and rejects evidence for a different commit", () => {
    const runner = vi
      .fn<ForgeRunner>()
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce(
        JSON.stringify([{ id: 6, name: "lint", ref: base, sha: otherSha, status: "success" }]),
      );
    const forge = createForge({ ...checks, provider: "gitlab" }, runner);
    expect(forge.verifyCi(mergeSha, base).state).toBe("pending");
    expect(forge.verifyCi(mergeSha, base).state).toBe("unknown");
  });

  it("leaves an empty required check policy unknown without reading the provider", () => {
    const runner = vi.fn<ForgeRunner>();
    const forge = createForge({ ...checks, provider: "github", requiredChecks: [] }, runner);
    expect(forge.verifyCi(mergeSha)).toEqual({ checks: [], sha: mergeSha, state: "unknown" });
    expect(runner).not.toHaveBeenCalled();
  });
});
