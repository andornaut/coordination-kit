// The standalone lifecycle. The project owner performs external actions explicitly, using
// the task's recorded candidate and review policy as the merge fence.
import { createHash } from "node:crypto";
import { join } from "node:path";

import { createForge, ForgeError } from "../adapters/forge/index.ts";
import { systemGit } from "../core/git.ts";
import { loadLayout } from "../core/layout.ts";
import { LockBusy, withLock } from "../core/lock.ts";
import {
  STANDALONE_CONFIG_FILE,
  type StandaloneConfig,
  validateStandaloneConfig,
} from "../core/standalone.ts";
import { resolveHarness } from "../registry/resolve.ts";
import type { Store } from "../store/db.ts";
import { resolveCaller } from "../store/identity.ts";
import { closeProjectTask, replaceProjectDependency } from "../store/projectDependencies.ts";
import {
  approveProjectReview,
  approveProjectTask,
  landProjectTask,
  linkProjectReview,
  listProjectTasks,
  mergeProjectTask,
  type ProjectTask,
  proposeProjectTask,
  readProjectTask,
  readyProjectTask,
  startProjectTask,
} from "../store/projectTasks.ts";
import { holdGuard } from "../store/questions.ts";
import { registry, withStore } from "../store/service.ts";
import { ensure, StoreError } from "../store/types.ts";
import { projectBase, projectCandidate, projectLanding } from "../work/projectGit.ts";
import {
  CALLER,
  callerOf,
  required,
  systemClock,
  text,
  Usage,
  type Values,
  verbFamily,
} from "./args.ts";
import { projectRoot } from "./init.ts";

export const TASK_READ_OPTIONS = {} as const;
export const TASK_WRITE_OPTIONS = CALLER;
export const TASK_PROPOSE_OPTIONS = {
  ...CALLER,
  "depends-on": { multiple: true, type: "string" },
  owner: { type: "string" },
  scope: { type: "string" },
  title: { type: "string" },
} as const;
export const TASK_APPROVE_OPTIONS = { ...CALLER, approval: { type: "string" } } as const;
export const TASK_CLOSE_OPTIONS = {
  ...TASK_APPROVE_OPTIONS,
  as: { type: "string" },
  reason: { type: "string" },
} as const;
export const TASK_REPLACE_OPTIONS = {
  ...TASK_APPROVE_OPTIONS,
  dependency: { type: "string" },
  replacement: { type: "string" },
} as const;
export const TASK_REVIEW_APPROVE_OPTIONS = {
  ...TASK_APPROVE_OPTIONS,
  head: { type: "string" },
  revision: { type: "string" },
} as const;
export const TASK_READY_OPTIONS = {
  ...CALLER,
  base: { type: "string" },
  branch: { type: "string" },
  evidence: { type: "string" },
  head: { type: "string" },
  "refresh-policy": { type: "boolean" },
  summary: { type: "string" },
} as const;
export const TASK_LINK_OPTIONS = { ...CALLER, number: { type: "string" } } as const;
export const TASK_VERIFY_OPTIONS = { ...CALLER, evidence: { type: "string" } } as const;

const task = verbFamily("task", (io, root) => {
  const git = systemGit(io.env, undefined, 30_000);
  let primary: string;
  try {
    primary = projectRoot(git, root);
  } catch {
    throw Object.assign(new StoreError("project-primary-root-required"), {
      reason: "use --root with the primary checkout",
    });
  }
  const layout = loadLayout(primary);
  const settings = layout.project;
  ensure(settings !== undefined, "standalone-project-required");
  const branch = settings.defaultBranch ?? "main";
  const remote = settings.remote ?? "origin";
  return {
    branch,
    clock: systemClock,
    env: io.env,
    git,
    layout,
    remote,
    settings,
    target: `refs/remotes/${remote}/${branch}`,
  };
});

type Context = Parameters<Parameters<typeof task>[2]>[0];
type Candidate = NonNullable<ProjectTask["candidate"]>;

function exactTask(store: Store, id: string): ProjectTask {
  const record = readProjectTask(store.db, id);
  ensure(record !== null && record !== undefined, "project-task-missing");
  return record;
}

function candidateOf(record: ProjectTask): Candidate {
  ensure(record.candidate !== null && record.candidate !== undefined, "project-task-not-ready");
  return record.candidate;
}

async function mutate<T>(
  context: Context,
  values: Values,
  action: (store: Store, actor: ReturnType<typeof resolveCaller>) => T | Promise<T>,
): Promise<T> {
  try {
    // Keep a task update and its external action ordered. The store itself still uses short
    // transactions. Closing the command releases the process-owned lock.
    return await withLock(
      join(context.layout.varDir, "project-tasks.lock"),
      () => {
        const roles = registry(context);
        const actor = resolveCaller(roles, context.env, callerOf(values));
        const binding = roles.roles[actor.role];
        ensure(
          binding?.ownership === "active" &&
            binding.phase !== "held" &&
            binding.phase !== "source-held" &&
            actor.worker === undefined,
          "project-actor-inactive",
        );
        return withStore(context, (store) => {
          ensure(
            holdGuard(store, actor.role, resolveHarness(roles, actor.role)).status === "clear",
            "project-role-held",
          );
          return action(store, actor);
        });
      },
      { nonBlocking: true },
    );
  } catch (error) {
    if (error instanceof LockBusy) {
      throw new StoreError("project-operation-in-progress");
    }
    if (error instanceof ForgeError) {
      throw new StoreError(error.code);
    }
    throw error;
  }
}

function approval(context: Context, values: Values, role: string) {
  ensure(role === context.settings.project.roles[0], "project-maintainer-required");
  return { kind: "user-decision" as const, ref: required(values, "approval") };
}

function owner(record: ProjectTask, role: string): void {
  ensure(record.owner === role, "project-task-not-owner");
}

function forge(context: Context) {
  const target = context.settings.integration;
  ensure(target !== undefined, "project-forge-unconfigured");
  return createForge({ ...target, requiredChecks: target.requiredChecks ?? [] });
}

function git(context: Context, args: readonly string[], failure: string): string {
  try {
    return context.git(context.layout.root, args).trim();
  } catch {
    throw new StoreError(failure);
  }
}

function refresh(context: Context, branch = context.branch): void {
  const ref = `refs/heads/${branch}`;
  const tracking = `refs/remotes/${context.remote}/${branch}`;
  git(
    context,
    ["fetch", "--no-tags", "--", context.remote, `${ref}:${tracking}`],
    "project-fetch-failed",
  );
}

function branchOf(context: Context, values: Values): string {
  const branch = required(values, "branch");
  ensure(
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) && branch !== context.branch,
    "invalid-project-branch",
  );
  git(context, ["check-ref-format", `refs/heads/${branch}`], "invalid-project-branch");
  return branch;
}

function reviewNumber(values: Values): number {
  const number = Number(required(values, "number"));
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Usage();
  }
  return number;
}

type Review = Awaited<ReturnType<ReturnType<typeof forge>["read"]>>;

function checkReview(context: Context, candidate: Candidate, review: Review): void {
  ensure(
    review.base === context.branch &&
      review.head === candidate.branch &&
      review.headSha === candidate.headSha,
    "project-review-head-mismatch",
  );
}

function exactApproval(record: ProjectTask, candidate: Candidate): void {
  ensure(
    record.reviewApproval?.headSha === candidate.headSha &&
      record.reviewApproval.candidateRevision === record.candidateRevision,
    "project-review-approval-required",
  );
}

function taskFile(record: ProjectTask): string {
  ensure(record.state !== "declined" && record.state !== "cancelled", "project-task-closed");
  ensure(record.approval !== null, "project-build-approval-required");
  return [
    `# ${record.title}`,
    "",
    `Task: ${record.id}`,
    `Owner: ${record.owner}`,
    `Approved: ${record.approval.at.slice(0, 10)}`,
    ...(record.dependsOn.length === 0 ? [] : [`Depends on: ${record.dependsOn.join(", ")}`]),
    "",
    "## Approved scope",
    "",
    record.scope,
    "",
  ].join("\n");
}

function hashPolicy(fields: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function targetFields(settings: StandaloneConfig): readonly unknown[] {
  return [
    settings.remote ?? "origin",
    settings.defaultBranch ?? "main",
    settings.integration?.provider,
    settings.integration?.repository,
    settings.integration?.hostname,
  ];
}

function policySha(settings: StandaloneConfig): string {
  return hashPolicy([
    settings.review,
    ...targetFields(settings),
    settings.integration?.mergeMethod,
    [...(settings.integration?.requiredChecks ?? [])].sort(),
  ]);
}

function originalTarget(context: Context, candidate: Candidate): void {
  if (candidate.policySha === policySha(context.settings)) {
    return;
  }
  let target = candidate.targetPolicySha;
  if (target === undefined) {
    // Legacy candidates carry only the full policy digest. Their committed base can prove
    // which target was approved if it contains the exact settings used at readiness.
    try {
      const source = context.git(context.layout.root, [
        "show",
        `${candidate.baseSha}:${STANDALONE_CONFIG_FILE}`,
      ]);
      const prior = validateStandaloneConfig(JSON.parse(source));
      if (policySha(prior) === candidate.policySha) {
        target = hashPolicy(targetFields(prior));
      }
    } catch {
      throw new StoreError("project-original-policy-unverified");
    }
  }
  ensure(target !== undefined, "project-original-policy-unverified");
  ensure(target === hashPolicy(targetFields(context.settings)), "project-merge-target-changed");
}

export const taskList = task("task list", TASK_READ_OPTIONS, (context) =>
  withStore(context, (store) => ({ schema: 1, tasks: listProjectTasks(store.db) }), {
    createMissing: false,
  }),
);

export const taskShow = task(
  "task show",
  TASK_READ_OPTIONS,
  (context, _values, [id]) =>
    withStore(context, (store) => ({ schema: 1, task: exactTask(store, id!) }), {
      createMissing: false,
    }),
  1,
);

export const taskWorkFile = task(
  "task work-file",
  TASK_READ_OPTIONS,
  (context, _values, [id]) =>
    withStore(context, (store) => `${taskFile(exactTask(store, id!))}\n`, { createMissing: false }),
  1,
);

export const taskPropose = task(
  "task propose",
  TASK_PROPOSE_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, (store, actor) => {
      const assigned = required(values, "owner");
      ensure(context.settings.project.roles.includes(assigned), "project-owner-unconfigured");
      return proposeProjectTask(store, actor, {
        dependsOn: (values["depends-on"] as string[] | undefined) ?? [],
        id: id!,
        owner: assigned,
        scope: required(values, "scope"),
        title: required(values, "title"),
      });
    }),
  1,
);

export const taskApprove = task(
  "task approve",
  TASK_APPROVE_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, (store, actor) =>
      approveProjectTask(store, actor, id!, approval(context, values, actor.role)),
    ),
  1,
);

export const taskStart = task(
  "task start",
  TASK_WRITE_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, (store, actor) => startProjectTask(store, actor, id!)),
  1,
);

export const taskClose = task(
  "task close",
  TASK_CLOSE_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, async (store, actor) => {
      const decision = approval(context, values, actor.role);
      const state = required(values, "as");
      if (state !== "declined" && state !== "cancelled") {
        throw new Usage();
      }
      const reason = required(values, "reason");
      const record = exactTask(store, id!);
      if (state === "cancelled" && record.state === "ready") {
        await verifyUnmerged(context, record, candidateOf(record));
      }
      return closeProjectTask(store, actor, record.id, { approval: decision, reason, state });
    }),
  1,
);

export const taskReplaceDependency = task(
  "task replace-dependency",
  TASK_REPLACE_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, (store, actor) =>
      replaceProjectDependency(store, actor, id!, {
        approval: approval(context, values, actor.role),
        dependency: required(values, "dependency"),
        replacement: required(values, "replacement"),
      }),
    ),
  1,
);

export const taskReady = task(
  "task ready",
  TASK_READY_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, async (store, actor) => {
      const record = exactTask(store, id!);
      owner(record, actor.role);
      const branch = branchOf(context, values);
      const headSha = required(values, "head");
      const requestedBase = text(values, "base");
      const refreshPolicy = values["refresh-policy"] === true;
      const policy = policySha(context.settings);
      const previous = record.candidate;
      if (refreshPolicy) {
        ensure(
          record.state === "ready" &&
            previous?.headSha === headSha &&
            previous.policySha !== policy,
          "project-policy-refresh-unavailable",
        );
        ensure(
          previous.branch === branch &&
            (requestedBase === undefined || requestedBase === previous.baseSha),
          "project-candidate-conflict",
        );
        await verifyUnmerged(context, record, previous);
      }
      const baseSha =
        requestedBase ??
        (refreshPolicy ? previous?.baseSha : undefined) ??
        projectBase(context.git, context.layout.root, context.target);
      const proof = projectCandidate(context.git, context.layout.root, {
        baseSha,
        headSha,
        remoteRef: context.target,
      });
      const file = git(
        context,
        ["show", `${headSha}:docs/work/${record.id}.md`],
        "project-work-file-required",
      );
      ensure(file === taskFile(record).trim(), "project-work-file-mismatch");
      return {
        ...readyProjectTask(
          store,
          actor,
          record.id,
          {
            baseSha,
            branch,
            evidence: required(values, "evidence"),
            headSha,
            policySha: policy,
            review: context.settings.review,
            summary: required(values, "summary"),
            ...(previous?.headSha === headSha &&
            previous.policySha === policy &&
            previous.targetPolicySha === undefined
              ? {}
              : { targetPolicySha: hashPolicy(targetFields(context.settings)) }),
          },
          refreshPolicy,
        ),
        changedPaths: proof.changedPaths,
      };
    }),
  1,
);

export const taskApproveReview = task(
  "task approve-review",
  TASK_REVIEW_APPROVE_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, (store, actor) => {
      const record = exactTask(store, id!);
      changedPolicy(context, candidateOf(record));
      return approveProjectReview(
        store,
        actor,
        record.id,
        required(values, "head"),
        approval(context, values, actor.role),
        text(values, "revision"),
      );
    }),
  1,
);

export const taskOpenReview = task(
  "task open-review",
  TASK_WRITE_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, async (store, actor) => {
      const record = exactTask(store, id!);
      owner(record, actor.role);
      const candidate = candidateOf(record);
      ensure(record.state === "ready" && candidate.review === "pr", "project-pr-review-required");
      changedPolicy(context, candidate);
      if (record.reviewRequest !== null) {
        return { duplicate: true, task: record };
      }
      refresh(context, candidate.branch);
      const pushed = projectBase(
        context.git,
        context.layout.root,
        `refs/remotes/${context.remote}/${candidate.branch}`,
      );
      ensure(pushed === candidate.headSha, "project-review-head-mismatch");
      const review = await forge(context).create({
        base: context.branch,
        body: [
          candidate.summary,
          "",
          `Task: ${record.id}`,
          `Revision: ${candidate.headSha}`,
          `Checks: ${candidate.evidence}`,
        ].join("\n"),
        head: candidate.branch,
        headSha: candidate.headSha,
        title: record.title,
      });
      checkReview(context, candidate, review);
      return linkProjectReview(store, actor, record.id, candidate.headSha, review);
    }),
  1,
);

export const taskLinkReview = task(
  "task link-review",
  TASK_LINK_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, async (store, actor) => {
      const record = exactTask(store, id!);
      owner(record, actor.role);
      const candidate = candidateOf(record);
      ensure(candidate.review === "pr", "project-pr-review-required");
      changedPolicy(context, candidate);
      const review = await forge(context).read(reviewNumber(values));
      checkReview(context, candidate, review);
      ensure(review.state !== "closed", "project-review-closed");
      return linkProjectReview(store, actor, record.id, candidate.headSha, review);
    }),
  1,
);

function landing(context: Context, candidate: Candidate, review?: Review) {
  return projectLanding(
    context.git,
    context.layout.root,
    { baseSha: candidate.baseSha, headSha: candidate.headSha, remoteRef: context.target },
    review?.mergeSha == null
      ? undefined
      : { headSha: review.headSha, mergeSha: review.mergeSha, remoteRef: context.target },
  );
}

async function readLinkedReview(
  context: Context,
  record: ProjectTask,
  candidate: Candidate,
): Promise<Review> {
  ensure(
    record.reviewRequest !== null &&
      record.reviewRequest.candidateRevision === record.candidateRevision,
    "project-review-link-required",
  );
  const review = await forge(context).read(record.reviewRequest.number);
  checkReview(context, candidate, review);
  return review;
}

function changedPolicy(context: Context, candidate: Candidate): void {
  ensure(candidate.policySha === policySha(context.settings), "project-review-policy-changed");
}

async function verifyUnmerged(
  context: Context,
  record: ProjectTask,
  candidate: Candidate,
): Promise<void> {
  originalTarget(context, candidate);
  if (candidate.review === "pr" && record.reviewRequest !== null) {
    const review = await readLinkedReview(context, record, candidate);
    ensure(review.state !== "merged", "project-merge-already-observed");
  }
  refresh(context);
  try {
    landing(context, candidate);
  } catch (error) {
    if (error instanceof StoreError && error.code === "project-candidate-not-landed") {
      return;
    }
    throw error;
  }
  throw new StoreError("project-merge-already-observed");
}

export const taskMerge = task(
  "task merge",
  TASK_WRITE_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, async (store, actor) => {
      const record = exactTask(store, id!);
      owner(record, actor.role);
      const candidate = candidateOf(record);
      ensure(record.state === "ready", "project-task-not-ready");
      changedPolicy(context, candidate);
      if (candidate.review !== "off") {
        exactApproval(record, candidate);
      }
      if (candidate.review === "pr") {
        const review = await readLinkedReview(context, record, candidate);
        ensure(review.state === "open", "project-review-not-open");
        await forge(context).merge({
          base: context.branch,
          headSha: candidate.headSha,
          number: review.number,
        });
        // The provider may complete asynchronously. Verification reads the exact merge later.
        return { submitted: true, task: record };
      }
      if ((context.settings.integration?.requiredChecks?.length ?? 0) > 0) {
        const ci = await forge(context).verifyCi(candidate.headSha);
        ensure(ci.state === "passed", "project-candidate-checks-unverified");
      }
      refresh(context);
      projectCandidate(context.git, context.layout.root, {
        baseSha: candidate.baseSha,
        headSha: candidate.headSha,
        remoteRef: context.target,
      });
      git(
        context,
        ["push", "--", context.remote, `${candidate.headSha}:refs/heads/${context.branch}`],
        "project-push-unverified",
      );
      return { submitted: true, task: record };
    }),
  1,
);

export const taskVerify = task(
  "task verify",
  TASK_VERIFY_OPTIONS,
  (context, values, [id]) =>
    mutate(context, values, async (store, actor) => {
      const record = exactTask(store, id!);
      owner(record, actor.role);
      if (record.state === "landed") {
        return { duplicate: true, task: record };
      }
      const candidate = candidateOf(record);
      originalTarget(context, candidate);
      let review: Review | undefined;
      if (candidate.review === "pr") {
        review = await readLinkedReview(context, record, candidate);
        ensure(review.state === "merged" && review.mergeSha !== null, "project-review-not-merged");
      }
      if (candidate.review === "chat") {
        exactApproval(record, candidate);
      }
      refresh(context);
      const proof = landing(context, candidate, review);
      const merged = mergeProjectTask(store, actor, record.id, candidate.headSha, proof.landedSha);
      if ((context.settings.integration?.requiredChecks?.length ?? 0) > 0) {
        const ci = await forge(context).verifyCi(proof.landedSha, context.branch);
        if (ci.state !== "passed") {
          return { ci, task: merged.task };
        }
        return {
          ci,
          ...landProjectTask(
            store,
            actor,
            record.id,
            candidate.headSha,
            proof.landedSha,
            `ci:${ci.sha}`,
          ),
        };
      }
      const evidence = text(values, "evidence");
      return evidence === undefined
        ? merged
        : landProjectTask(store, actor, record.id, candidate.headSha, proof.landedSha, evidence);
    }),
  1,
);
