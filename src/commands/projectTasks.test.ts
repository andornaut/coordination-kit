import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { main } from "../cli.ts";

const MAINTAINER = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const TASK = "task-0001";
const forge = vi.hoisted(() => ({
  create: vi.fn(),
  merge: vi.fn(),
  read: vi.fn(),
  verifyCi: vi.fn(),
}));
const forgeTarget = vi.hoisted(() => vi.fn());
vi.mock("../adapters/forge/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/forge/index.ts")>()),
  createForge: (target: unknown) => {
    forgeTarget(target);
    return forge;
  },
}));

async function exactLanding(mode: "chat" | "pr-squash" | "pr-merge"): Promise<void> {
  const review = mode === "chat" ? "chat" : "pr";
  vi.resetAllMocks();
  const scratch = mkdtempSync(join(tmpdir(), "ck-project-"));
  try {
    const repo = join(scratch, "product");
    mkdirSync(repo);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const invoke = async (caller: string, ...args: string[]) => {
      let out = "";
      let err = "";
      const code = await main(
        {
          cwd: repo,
          env: { ...process.env, CODEX_THREAD_ID: caller },
          err: (text) => {
            err += text;
          },
          out: (text) => {
            out += text;
          },
        },
        args,
      );
      return { code, err, out };
    };
    const ok = async (caller: string, ...args: string[]) => {
      const result = await invoke(caller, ...args);
      expect(result.err).toBe("");
      expect(result.code).toBe(0);
      return result.out;
    };
    const setup = async (...args: string[]) => ok(MAINTAINER, ...args);

    git("init", "-b", "main");
    git("init", "--bare", join(scratch, "remote"));
    git("config", "user.name", "Test Maintainer");
    git("config", "user.email", "maintainer@example.test");
    git("remote", "add", "origin", join(scratch, "remote"));

    await setup(
      "init",
      "--project",
      "product",
      "--role",
      "maintainer",
      "--role",
      "implementation",
      "--review",
      review,
    );
    if (review === "pr") {
      const configFile = join(repo, "coordination-kit.json");
      const config = JSON.parse(readFileSync(configFile, "utf8"));
      config.integration = {
        provider: "github",
        repository: "example/product",
        requiredChecks: ["tests"],
      };
      writeFileSync(configFile, JSON.stringify(config));
    }
    await setup(
      "project",
      "register",
      "--role",
      "maintainer",
      "--harness",
      "codex",
      "--native-id",
      MAINTAINER,
      "--native-project-id",
      "product",
    );
    await setup(
      "project",
      "register",
      "--role",
      "implementation",
      "--harness",
      "codex",
      "--native-id",
      OWNER,
    );
    expect(JSON.parse(await ok(OWNER, "session", "start")).checkpoint).toBe(
      ".coordination-kit/handoffs/implementation/current.md",
    );

    git("add", ".gitignore", "coordination-kit.json");
    git("commit", "-m", "Set up product workflow");
    git("push", "-u", "origin", "main");
    await setup(
      "task",
      "propose",
      TASK,
      "--owner",
      "implementation",
      "--title",
      "Fix input",
      "--scope",
      "Reject blank input.",
    );
    expect(await invoke(OWNER, "task", "approve", TASK, "--approval", "chat:build")).toMatchObject({
      code: 1,
      err: "coordination-kit: project-maintainer-required\n",
    });
    await setup("task", "approve", TASK, "--approval", "chat:build");
    await ok(OWNER, "task", "start", TASK);
    git("checkout", "-b", "task/input");
    mkdirSync(join(repo, "docs", "work"), { recursive: true });
    writeFileSync(join(repo, "docs", "work", `${TASK}.md`), await setup("task", "work-file", TASK));
    writeFileSync(join(repo, "input.txt"), "first\n");
    git("add", "docs/work", "input.txt");
    git("commit", "-m", "Fix input");

    const ready = async () => {
      const sha = git("rev-parse", "HEAD");
      const packet = JSON.parse(
        await ok(
          OWNER,
          "task",
          "ready",
          TASK,
          "--branch",
          "task/input",
          "--head",
          sha,
          "--summary",
          "Input validated",
          "--evidence",
          "checks:focused",
        ),
      );
      expect(packet).toMatchObject({
        changedPaths: [`docs/work/${TASK}.md`, "input.txt"],
        task: { state: "ready" },
      });
      return sha;
    };
    const first = await ready();
    expect(await invoke(OWNER, "task", "merge", TASK)).toMatchObject({
      code: 1,
      err: "coordination-kit: project-review-approval-required\n",
    });
    await setup("task", "approve-review", TASK, "--head", first, "--approval", "chat:first-review");

    writeFileSync(join(repo, "input.txt"), "second\n");
    git("add", "input.txt");
    git("commit", "-m", "Cover another input case");
    const head = await ready();
    expect(await invoke(OWNER, "task", "merge", TASK)).toMatchObject({
      code: 1,
      err: "coordination-kit: project-review-approval-required\n",
    });
    if (review === "chat") {
      await setup(
        "task",
        "approve-review",
        TASK,
        "--head",
        head,
        "--approval",
        "chat:exact-review",
      );
      expect(JSON.parse(await ok(OWNER, "task", "merge", TASK))).toMatchObject({ submitted: true });
      expect(JSON.parse(await ok(OWNER, "task", "verify", TASK))).toMatchObject({
        task: { mergedSha: head, state: "merged" },
      });
      expect(
        JSON.parse(await ok(OWNER, "task", "verify", TASK, "--evidence", "checks:landed")),
      ).toMatchObject({
        task: { mergedSha: head, state: "landed" },
      });
    } else {
      git("push", "-u", "origin", "task/input");
      const policyFile = join(repo, "coordination-kit.json");
      const policy = readFileSync(policyFile, "utf8");
      const changed = JSON.parse(policy);
      changed.integration.requiredChecks = ["different-check"];
      writeFileSync(policyFile, JSON.stringify(changed));
      const refusal = { code: 1, err: "coordination-kit: project-review-policy-changed\n" };
      expect(await invoke(OWNER, "task", "open-review", TASK)).toMatchObject(refusal);
      expect(await invoke(OWNER, "task", "link-review", TASK, "--number", "4")).toMatchObject(
        refusal,
      );
      expect(forge.create).not.toHaveBeenCalled();
      expect(forge.read).not.toHaveBeenCalled();
      writeFileSync(policyFile, policy);

      const open = {
        base: "main",
        head: "task/input",
        headSha: head,
        mergeSha: null,
        number: 4,
        state: "open",
        url: "https://github.com/example/product/pull/4",
      };
      forge.create.mockResolvedValue(open);
      await ok(OWNER, "task", "open-review", TASK);
      expect(forge.create).toHaveBeenCalledWith(expect.objectContaining({ headSha: head }));

      // An unchanged head can return to review under a changed policy, with a new approval.
      forge.read.mockResolvedValue(open);
      writeFileSync(policyFile, JSON.stringify(changed));
      const refreshed = JSON.parse(
        await ok(
          OWNER,
          "task",
          "ready",
          TASK,
          "--branch",
          "task/input",
          "--head",
          head,
          "--summary",
          "Review again",
          "--evidence",
          "checks:refreshed",
          "--refresh-policy",
        ),
      );
      expect(refreshed.task).toMatchObject({
        candidateRevision: expect.any(String),
        requiresRevisionApproval: true,
        reviewRequest: null,
      });
      const approve = [
        "task",
        "approve-review",
        TASK,
        "--head",
        head,
        "--approval",
        "chat:refresh",
      ];
      expect(await invoke(MAINTAINER, ...approve)).toMatchObject({
        code: 1,
        err: "coordination-kit: project-candidate-revision-mismatch\n",
      });
      await setup(...approve, "--revision", refreshed.task.candidateRevision);
      await ok(OWNER, "task", "link-review", TASK, "--number", "4");

      // Simulate the provider merge after a human action and check the exact merge SHA.
      git("checkout", "main");
      if (mode === "pr-squash") {
        git("merge", "--squash", "task/input");
        git("commit", "-m", "Human squash merge");
      } else {
        git("merge", "--no-ff", "-m", "Human merge commit", "task/input");
        git("merge-base", "--is-ancestor", head, "HEAD");
      }
      git("push", "origin", "main");
      const merge = git("rev-parse", "HEAD");
      expect(merge).not.toBe(head);
      forge.read.mockResolvedValue({ ...open, mergeSha: merge, state: "merged" });
      let state = "pending";
      forge.verifyCi.mockImplementation((sha: string) =>
        Promise.resolve({ sha, state: sha === merge ? state : "passed" }),
      );
      expect(JSON.parse(await ok(OWNER, "task", "verify", TASK))).toMatchObject({
        ci: { sha: merge, state: "pending" },
        task: { mergedSha: merge, state: "merged" },
      });
      changed.integration.requiredChecks = ["landing-check"];
      writeFileSync(policyFile, JSON.stringify(changed));
      state = "passed";
      expect(JSON.parse(await ok(OWNER, "task", "verify", TASK))).toMatchObject({
        task: { mergedSha: merge, state: "landed" },
      });
      expect(forge.verifyCi).toHaveBeenLastCalledWith(merge, "main");
      expect(forgeTarget).toHaveBeenLastCalledWith(
        expect.objectContaining({ requiredChecks: ["landing-check"] }),
      );
      expect(forge.merge).not.toHaveBeenCalled();
    }
    expect(JSON.parse(await setup("task", "list"))).toMatchObject({
      tasks: [{ id: TASK, owner: "implementation", state: "landed" }],
    });
    if (mode === "chat") {
      const propose = ["task", "propose"] as const;
      const scope = ["--owner", "implementation", "--scope", "Declared scope"] as const;
      await setup(...propose, "old-prerequisite", ...scope, "--title", "Old prerequisite");
      await setup(
        ...propose,
        "dependent",
        ...scope,
        "--title",
        "Dependent work",
        "--depends-on",
        "old-prerequisite",
      );
      await setup("task", "approve", "dependent", "--approval", "chat:dependent-build");
      await setup(
        "task",
        "close",
        "old-prerequisite",
        "--as",
        "declined",
        "--reason",
        "Superseded scope",
        "--approval",
        "chat:decline",
      );
      expect(await invoke(OWNER, "task", "start", "dependent")).toMatchObject({ code: 1 });
      const replace = [
        "task",
        "replace-dependency",
        "dependent",
        "--dependency",
        "old-prerequisite",
        "--replacement",
        TASK,
        "--approval",
        "chat:replacement",
      ];
      expect(await invoke(OWNER, ...replace)).toMatchObject({ code: 1 });
      await setup(...replace);
      expect(JSON.parse(await ok(OWNER, "task", "start", "dependent"))).toMatchObject({
        task: { dependsOn: [TASK], state: "in-progress" },
      });
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

it.each(["chat", "pr-squash", "pr-merge"] as const)(
  "runs standalone %s review through exact landing",
  exactLanding,
);
