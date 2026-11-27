import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ForgeRunner } from "../../adapters/forge/types.ts";
import { main } from "../../cli.ts";
import { loadLayout } from "../../core/configuration/layout.ts";
import { validateStandaloneConfig } from "../../core/configuration/standalone.ts";
import { TEST_CLOCK } from "../../core/testFixtures.ts";
import { createRegistry } from "../../registry/store.ts";
import { Store } from "../../store/db.ts";
import {
  approveProjectTask,
  landProjectTask,
  linkProjectReview,
  mergeProjectTask,
  proposeProjectTask,
  readProjectTask,
  readyProjectTask,
  startProjectTask,
} from "../../store/projects/tasks.ts";
import { GitHubTasks } from "./githubTasks.ts";

const liveForge = vi.hoisted(() =>
  vi.fn<ForgeRunner>(() => {
    throw new Error("live transport must not run");
  }),
);
vi.mock("../../adapters/forge/api.ts", async (original) => ({
  ...(await original<typeof import("../../adapters/forge/api.ts")>()),
  runForge: liveForge,
}));

const ROOT = "repos/example/product/issues/";
const URL = "https://github.com/example/product";
const WRITER = 42;
const CONTROL = 99;
const ACTOR = { nativeId: "00000000-0000-4000-8000-000000000001", role: "operator" };
const APPROVAL = { kind: "user-decision", ref: "discussion:17" } as const;
const HEAD = "b".repeat(40);
const LANDED = "c".repeat(40);
const SETTINGS = { backend: "github-issues", issue: CONTROL, writers: [WRITER] } as const;

function fixture() {
  const issues = new Map(
    [1, 2, CONTROL].map((number) => [
      number,
      {
        html_url: `${URL}/issues/${number}`,
        number,
        state: "open",
      },
    ]),
  );
  const comments = new Map<number, { id: number; body: string; user: { id: number } }[]>();
  let account = WRITER;
  let next = 0;
  let ambiguous = false;
  let unavailableClose = false;
  function comment(issue: number, body: string, author = account) {
    const all = comments.get(issue) ?? [];
    const row = { body, id: ++next, user: { id: author } };
    all.push(row);
    comments.set(issue, all);
    return row;
  }
  const api = vi.fn((path: string, method = "GET", data?: Readonly<Record<string, unknown>>) => {
    if (path === "user") {
      return { id: account };
    }
    const endpoint = path.slice(ROOT.length).split("?")[0]!;
    const [raw, suffix] = endpoint.split("/");
    const issue = issues.get(Number(raw));
    if (issue === undefined) {
      throw new Error("missing issue");
    }
    if (suffix === "comments") {
      if (method === "POST") {
        const row = comment(issue.number, data?.body as string);
        if (issue.number === CONTROL && ambiguous) {
          ambiguous = false;
          throw new Error("lost response");
        }
        return row;
      }
      return comments.get(issue.number) ?? [];
    }
    if (method === "PATCH") {
      if (unavailableClose) {
        throw new Error("provider rejected closure");
      }
      issue.state = data?.state as string;
    }
    return { ...issue, comments: comments.get(issue.number)?.length ?? 0 };
  });
  return {
    api,
    comment,
    comments,
    issues,
    client: () => new GitHubTasks("example/product", "product", SETTINGS, api),
    clearAcknowledgement: () => {
      ambiguous = true;
    },
    blockClose: (value: boolean) => {
      unavailableClose = value;
    },
    writer: (value: number) => {
      account = value;
    },
  };
}

function summary(id: string) {
  return (store: Store) => readProjectTask(store.index, id)!;
}

function proposal(client: GitHubTasks, id: string, scope: string, before?: Promise<void>) {
  return client.mutate(TEST_CLOCK, ACTOR, id, async (store, actor) => {
    await before;
    return proposeProjectTask(store, actor, { id, owner: actor.role, scope, title: "One task" });
  });
}

describe("GitHub task storage", () => {
  it("guards GitHub PR opening and merging before any provider or task-store effects", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ck-github-task-guards-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
      writeFileSync(
        join(repo, "coordination-kit.json"),
        JSON.stringify({
          integration: { provider: "github", repository: "example/product" },
          project: { id: "product", roles: ["operator"] },
          review: "pr",
          schema: 1,
          taskStore: SETTINGS,
        }),
      );
      const guarded = await Promise.all(
        ["open-review", "merge"].map(async (verb) => {
          let err = "";
          const code = await main(
            {
              cwd: repo,
              env: {},
              err: (value) => {
                err += value;
              },
              out: () => {},
            },
            ["task", verb, "issue-1"],
          );
          return { code, err };
        }),
      );
      for (const { code, err } of guarded) {
        expect(code).not.toBe(0);
        expect(err).toContain("project-github-use-native-pr");
      }
      expect(liveForge).not.toHaveBeenCalled();
    } finally {
      rmSync(repo, { force: true, recursive: true });
    }
  });

  it("routes CLI proposals and reads through GitHub while keeping local task authority empty", async () => {
    const repo = mkdtempSync(join(tmpdir(), "ck-github-task-cli-"));
    const remote = fixture();
    liveForge.mockImplementation((_command, args, input) =>
      JSON.stringify(
        remote.api(args[5]!, args[4], input === undefined ? undefined : JSON.parse(input)),
      ),
    );
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
      writeFileSync(join(repo, ".gitignore"), "/.coordination-kit/\n");
      writeFileSync(
        join(repo, "coordination-kit.json"),
        JSON.stringify({
          integration: { provider: "github", repository: "example/product" },
          project: { id: "product", roles: [ACTOR.role] },
          review: "pr",
          schema: 1,
          taskStore: SETTINGS,
        }),
      );
      const layout = loadLayout(repo);
      createRegistry(TEST_CLOCK, layout, {
        harness: "codex",
        host: { nativeProjectId: "product", root: "." },
        operations: {},
        roles: {
          [ACTOR.role]: {
            conversations: { codex: ACTOR.nativeId },
            ownership: "active",
            worktree: ".",
          },
        },
        schema: 1,
        transfers: [],
      });
      const invoke = async (...args: string[]) => {
        let err = "";
        let out = "";
        const code = await main(
          {
            cwd: repo,
            env: { CODEX_THREAD_ID: ACTOR.nativeId },
            err: (value) => {
              err += value;
            },
            out: (value) => {
              out += value;
            },
          },
          ["task", ...args],
        );
        expect(err).toBe("");
        expect(code).toBe(0);
        return JSON.parse(out);
      };
      await invoke("propose", "issue-1", "--title", "Fix exports", "--scope", "Use exact exports");
      expect(await invoke("show", "issue-1")).toMatchObject({
        task: { issue: { number: 1, url: `${URL}/issues/1` }, state: "proposed" },
      });
      const local = Store.readLayout({ env: {} }, layout)!;
      try {
        expect(readProjectTask(local.index, "issue-1")).toBeNull();
      } finally {
        local.close();
      }
    } finally {
      liveForge.mockReset();
      rmSync(repo, { force: true, recursive: true });
    }
  });
  it("requires a GitHub PR configuration and an explicit list of trusted writers", () => {
    const config = {
      integration: { provider: "github", repository: "example/product" },
      project: { id: "product", roles: ["operator"] },
      review: "pr",
      schema: 1,
      taskStore: SETTINGS,
    };
    expect(validateStandaloneConfig(config).taskStore).toEqual(SETTINGS);
    expect(() => validateStandaloneConfig({ ...config, review: "chat" })).toThrow(
      "requires review pr and a GitHub integration",
    );
    expect(() =>
      validateStandaloneConfig({ ...config, taskStore: { ...SETTINGS, writers: [] } }),
    ).toThrow("/taskStore/writers: must not be empty");
  });

  it("confirms the winning CAS from two clones and writes no status for a losing task", async () => {
    const remote = fixture();
    const first = remote.client();
    const second = remote.client();
    const staged = Promise.withResolvers<void>();
    const stale = proposal(first, "issue-1", "Original scope", staged.promise);
    await proposal(second, "issue-1", "Winning scope");
    staged.resolve();
    await expect(stale).rejects.toThrow("project-github-write-conflict");
    expect(first.read(TEST_CLOCK, summary("issue-1"))?.scope).toBe("Winning scope");
    expect(remote.comments.get(1)?.map(({ body }) => body)).toEqual([
      expect.stringContaining("Winning scope"),
    ]);
    expect(remote.comments.get(CONTROL)).toHaveLength(2);
  });

  it("reconciles an ambiguous accepted batch and keeps the native caller out of shared events", async () => {
    const remote = fixture();
    const client = remote.client();
    remote.clearAcknowledgement();
    await expect(proposal(client, "issue-1", "Visible scope")).resolves.toMatchObject({
      task: { proposal: { actor: { nativeId: `github-account:${WRITER}` } } },
    });
    const raw = remote.comments.get(CONTROL)![0]!.body.split("\n")[1]!;
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    expect(decoded).not.toContain(ACTOR.nativeId);
    expect(remote.comments.get(CONTROL)).toHaveLength(1);
    expect(remote.comments.get(1)?.[0]?.body).toContain("/issues/99#issuecomment-");
  });

  it("performs no provider writes for untrusted authors, invalid values or failed domain transitions", async () => {
    const remote = fixture();
    const client = remote.client();
    const untrusted = 123;
    remote.writer(untrusted);
    remote.comment(CONTROL, "<!-- coordination-kit:tasks:v1\nbad\n-->", untrusted);
    expect(client.read(TEST_CLOCK, summary("issue-1"))).toBeNull();
    await expect(proposal(client, "issue-1", "Scope")).rejects.toThrow(
      "project-github-writer-required",
    );
    remote.writer(WRITER);
    await expect(proposal(client, "issue-1", `See ${ACTOR.nativeId}`)).rejects.toThrow(
      "project-github-private-task-data",
    );
    await expect(proposal(client, "task-1", "Scope")).rejects.toThrow(
      "project-github-issue-id-required",
    );
    await expect(
      client.mutate(TEST_CLOCK, ACTOR, "issue-1", (store, actor) =>
        startProjectTask(store, actor, "issue-1"),
      ),
    ).rejects.toThrow("project-task-missing");
    await expect(proposal(client, "issue-99", "Scope")).rejects.toThrow(
      "project-github-control-issue-reserved",
    );
    expect(
      remote.api.mock.calls.every(([, method]) => method === undefined || method === "GET"),
    ).toBe(true);
    remote.comment(CONTROL, "<!-- coordination-kit:tasks:v1\nbad\n-->");
    expect(() => client.read(TEST_CLOCK, summary("issue-1"))).toThrow(
      "project-github-journal-invalid",
    );
  });

  it("shows a linked review on the real Issue and closes only after a landed receipt", async () => {
    const remote = fixture();
    const client = remote.client();
    const id = "issue-1";
    await proposal(client, id, "Visible scope");
    const mutate = (action: Parameters<GitHubTasks["mutate"]>[3]) =>
      client.mutate(TEST_CLOCK, ACTOR, id, action);
    await mutate((store, actor) => approveProjectTask(store, actor, id, APPROVAL));
    await mutate((store, actor) => startProjectTask(store, actor, id));
    await mutate((store, actor) =>
      readyProjectTask(store, actor, id, {
        baseSha: "a".repeat(40),
        branch: "task/issue-1",
        evidence: "checks:sample",
        headSha: HEAD,
        policySha: "e".repeat(64),
        review: "pr",
        summary: "Exact candidate",
      }),
    );
    await mutate((store, actor) =>
      linkProjectReview(store, actor, id, HEAD, { number: 3, url: `${URL}/pull/3` }),
    );
    expect(remote.comments.get(1)?.at(-1)?.body).toContain(`${URL}/pull/3`);
    await mutate((store, actor) => mergeProjectTask(store, actor, id, HEAD, LANDED));
    expect(remote.issues.get(1)?.state).toBe("open");
    expect(remote.api.mock.calls.some(([, method]) => method === "PATCH")).toBe(false);
    remote.blockClose(true);
    await expect(
      mutate((store, actor) => landProjectTask(store, actor, id, HEAD, LANDED, "ci:sample")),
    ).rejects.toThrow("project-github-issue-close-unverified");
    const receipts = remote.comments.get(CONTROL)?.length;
    expect(client.read(TEST_CLOCK, summary(id))?.state).toBe("landed");
    expect(remote.issues.get(1)?.state).toBe("open");
    remote.blockClose(false);
    await mutate((store, actor) => landProjectTask(store, actor, id, HEAD, LANDED, "ci:sample"));
    expect(remote.comments.get(CONTROL)?.length).toBe(receipts);
    expect(remote.issues.get(1)?.state).toBe("closed");
    expect(remote.comments.get(1)?.at(-1)?.body).toContain("**State:** landed");
  });
});
