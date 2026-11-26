// Standalone task commitments and progress, replayable from the same journal as the inbox.
import type { DatabaseSync } from "node:sqlite";

import type { Store } from "./db.ts";
import { canonicalJson } from "./eventCodec.ts";
import {
  type Actor,
  ensure,
  type JsonObject,
  type Projection,
  ROLE,
  type StoredEvent,
} from "./types.ts";
import { workText } from "./work.ts";

export type ProjectTaskState =
  | "proposed"
  | "approved"
  | "in-progress"
  | "ready"
  | "merged"
  | "landed"
  | "declined"
  | "cancelled";
export type ClosedProjectTaskState = Extract<ProjectTaskState, "declined" | "cancelled">;
export type ProjectReviewPolicy = "off" | "chat" | "pr";

export interface ProjectTaskProposal {
  readonly id: string;
  readonly title: string;
  readonly scope: string;
  readonly owner: string;
  readonly dependsOn?: readonly string[];
}

export interface ProjectApproval {
  readonly kind: "user-decision" | "user-message";
  readonly ref: string;
}

type BoundActor = Actor & { readonly role: string; readonly nativeId: string };
type Receipt = { readonly actor: BoundActor; readonly at: string };
type ApprovalReceipt = ProjectApproval & Receipt;

export interface ProjectTaskCandidate {
  readonly baseSha: string;
  readonly headSha: string;
  readonly policySha: string;
  readonly targetPolicySha?: string;
  readonly branch: string;
  readonly summary: string;
  readonly evidence: string;
  readonly review: ProjectReviewPolicy;
}

export interface ProjectReviewLink {
  readonly number: number;
  readonly url: string;
}

export interface ProjectTask extends ProjectTaskProposal {
  readonly dependsOn: readonly string[];
  readonly state: ProjectTaskState;
  readonly proposal: Receipt;
  readonly approval: ApprovalReceipt | null;
  readonly start: Receipt | null;
  readonly candidate: ProjectTaskCandidate | null;
  readonly candidateRevision: string | null;
  readonly requiresRevisionApproval: boolean;
  readonly reviewApproval: (ApprovalReceipt & CandidateReceipt) | null;
  readonly reviewRequest: (ProjectReviewLink & Receipt & CandidateReceipt) | null;
  readonly mergedSha: string | null;
  readonly landingEvidence: string | null;
  readonly closure?: ApprovalReceipt & { readonly reason: string };
  readonly dependencyReplacements?: readonly (ApprovalReceipt & {
    readonly dependency: string;
    readonly replacement: string;
  })[];
  readonly updatedAt: string;
}

interface CandidateReceipt {
  readonly headSha: string;
  readonly candidateRevision: string;
}

interface TaskWrite {
  readonly task: ProjectTask;
  readonly duplicate: boolean;
}

const TASK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const PROJECT_TASK_DISPOSITIONS = {
  closed: "project-task.closed",
  dependencyReplaced: "project-task.dependency-replaced",
} as const;
const EVENT = {
  ...PROJECT_TASK_DISPOSITIONS,
  approved: "project-task.approved",
  landed: "project-task.landed",
  merged: "project-task.merged",
  proposed: "project-task.proposed",
  ready: "project-task.ready",
  reviewApproved: "project-task.review-approved",
  reviewLinked: "project-task.review-linked",
  started: "project-task.started",
} as const;
type TaskEventKind = (typeof EVENT)[keyof typeof EVENT];
export const PROJECT_TASK_KINDS: ReadonlySet<string> = new Set(Object.values(EVENT));

const DDL = `
CREATE TABLE IF NOT EXISTS project_tasks (
  id TEXT PRIMARY KEY,
  record TEXT NOT NULL
);
`;

function taskRow(db: DatabaseSync, row: { record?: unknown } | undefined): ProjectTask | null {
  if (row === undefined) {
    return null;
  }
  const task = JSON.parse(row.record as string) as ProjectTask;
  if (
    task.candidateRevision != null ||
    (task.candidate === null && task.candidateRevision === null)
  ) {
    return task;
  }
  // Compatibility for an existing SQLite projection built before ready attempts carried revisions.
  const previous =
    task.candidate === null
      ? undefined
      : db
          .prepare(
            `SELECT hash, json_extract(payload, '$.policyRefresh') AS refreshed FROM events
                  WHERE kind = ? AND json_extract(payload, '$.id') = ?
                    AND json_extract(payload, '$.candidate.headSha') = ?
                  ORDER BY seq DESC LIMIT 1`,
          )
          .get(EVENT.ready, task.id, task.candidate.headSha);
  const candidateRevision = (previous?.hash as string | undefined) ?? null;
  return {
    ...task,
    candidateRevision,
    requiresRevisionApproval: previous?.refreshed === 1,
    ...(candidateRevision === null
      ? {}
      : {
          reviewApproval:
            task.reviewApproval === null ? null : { ...task.reviewApproval, candidateRevision },
          reviewRequest:
            task.reviewRequest === null ? null : { ...task.reviewRequest, candidateRevision },
        }),
  };
}

export function readProjectTask(db: DatabaseSync, id: string): ProjectTask | null {
  return taskRow(db, db.prepare("SELECT record FROM project_tasks WHERE id = ?").get(id));
}

export function listProjectTasks(db: DatabaseSync): ProjectTask[] {
  return db
    .prepare("SELECT record FROM project_tasks ORDER BY id")
    .all()
    .map((row) => taskRow(db, row)!);
}

function requiredTask(db: DatabaseSync, id: string): ProjectTask {
  ensure(TASK_ID.test(id), "invalid-project-task-id");
  const task = readProjectTask(db, id);
  ensure(task !== null, "project-task-missing");
  return task;
}

function bound(actor: Actor): asserts actor is BoundActor {
  ensure(
    actor.role !== null &&
      ROLE.test(actor.role) &&
      actor.nativeId !== null &&
      actor.nativeId !== "" &&
      actor.worker === undefined,
    "invalid-project-task-actor",
  );
}

function applyTask(db: DatabaseSync, event: StoredEvent): void {
  bound(event.actor);
  const receipt = { actor: event.actor, at: event.at };
  const id = event.payload.id as string;
  const payload = event.payload;
  if (event.kind === EVENT.proposed) {
    const task: ProjectTask = {
      approval: null,
      candidate: null,
      candidateRevision: null,
      dependsOn: payload.dependsOn as string[],
      id,
      landingEvidence: null,
      mergedSha: null,
      owner: payload.owner as string,
      proposal: receipt,
      requiresRevisionApproval: false,
      reviewApproval: null,
      reviewRequest: null,
      scope: payload.scope as string,
      start: null,
      state: "proposed",
      title: payload.title as string,
      updatedAt: event.at,
    };
    db.prepare("INSERT INTO project_tasks (id, record) VALUES (?, ?)").run(
      id,
      JSON.stringify(task),
    );
    return;
  }
  const previous = requiredTask(db, id);
  const patch = taskUpdate(event, previous, receipt);
  const task = { ...previous, ...patch, updatedAt: event.at };
  db.prepare("UPDATE project_tasks SET record = ? WHERE id = ?").run(JSON.stringify(task), id);
}

function taskUpdate(
  event: StoredEvent,
  previous: ProjectTask,
  receipt: Receipt,
): Partial<ProjectTask> {
  const { kind, payload } = event;
  const approval = (payload.approval ?? {}) as JsonObject;
  const approvalReceipt = {
    ...receipt,
    kind: approval.kind as ProjectApproval["kind"],
    ref: approval.ref as string,
  };
  switch (kind) {
    case EVENT.approved:
      return { approval: approvalReceipt, state: "approved" };
    case EVENT.closed:
      return {
        closure: { ...approvalReceipt, reason: payload.reason as string },
        state: payload.state as ClosedProjectTaskState,
      };
    case EVENT.dependencyReplaced:
      return {
        dependencyReplacements: [
          ...(previous.dependencyReplacements ?? []),
          {
            ...approvalReceipt,
            dependency: payload.dependency as string,
            replacement: payload.replacement as string,
          },
        ],
        dependsOn: payload.dependsOn as string[],
      };
    case EVENT.started:
      return { start: receipt, state: "in-progress" };
    case EVENT.ready:
      return {
        candidate: payload.candidate as unknown as ProjectTaskCandidate,
        candidateRevision: event.hash,
        landingEvidence: null,
        mergedSha: null,
        requiresRevisionApproval: payload.policyRefresh === true,
        reviewApproval: null,
        reviewRequest: null,
        state: "ready",
      };
    case EVENT.reviewApproved:
      return {
        reviewApproval: {
          ...approvalReceipt,
          candidateRevision: revisionOf(previous),
          headSha: payload.headSha as string,
        },
      };
    case EVENT.reviewLinked:
      return {
        reviewRequest: {
          ...receipt,
          candidateRevision: revisionOf(previous),
          headSha: payload.headSha as string,
          number: payload.number as number,
          url: payload.url as string,
        },
      };
    case EVENT.merged:
      return { mergedSha: payload.landedSha as string, state: "merged" };
    case EVENT.landed:
      return { landingEvidence: payload.evidence as string, state: "landed" };
    default:
      return {};
  }
}

export const PROJECT_TASKS_PROJECTION: Projection = {
  apply: Object.fromEntries(Object.values(EVENT).map((kind) => [kind, applyTask])),
  ddl: DDL,
  tables: ["project_tasks"],
};

function change(
  store: Store,
  actor: Actor,
  kind: TaskEventKind,
  task: { readonly id: string; readonly owner: string },
  payload: JsonObject = {},
  keySuffix?: string,
): TaskWrite {
  const key = `${kind}:${task.id}${keySuffix === undefined ? "" : `:${keySuffix}`}`;
  ensure(store.eventByKey(key) === undefined, "project-task-transition-conflict");
  store.append({ actor, key, kind, payload: { ...payload, id: task.id, owner: task.owner } });
  return { duplicate: false, task: requiredTask(store.db, task.id) };
}

function duplicate(task: ProjectTask): TaskWrite {
  return { duplicate: true, task };
}

/** The command fences the recorder and verifies that the assigned role is registered. */
export function proposeProjectTask(
  store: Store,
  actor: Actor,
  input: ProjectTaskProposal,
): TaskWrite {
  bound(actor);
  ensure(TASK_ID.test(input.id), "invalid-project-task-id");
  ensure(ROLE.test(input.owner), "invalid-project-task-owner");
  const title = workText(input.title, "invalid-project-task-title");
  const scope = workText(input.scope, "invalid-project-task-scope");
  const dependsOn = [...(input.dependsOn ?? [])].sort();
  ensure(new Set(dependsOn).size === dependsOn.length, "duplicate-project-task-dependency");
  ensure(!dependsOn.includes(input.id), "invalid-project-task-dependency");
  return store.transaction(() => {
    const task = readProjectTask(store.db, input.id);
    if (task !== null) {
      const original = store.eventByKey(`${EVENT.proposed}:${input.id}`)?.payload.dependsOn;
      ensure(
        task.title === title &&
          task.scope === scope &&
          task.owner === input.owner &&
          canonicalJson(original ?? task.dependsOn) === canonicalJson(dependsOn),
        "project-task-id-conflict",
      );
      return duplicate(task);
    }
    for (const id of dependsOn) {
      requiredTask(store.db, id);
    }
    return change(store, actor, EVENT.proposed, input, { dependsOn, scope, title });
  });
}

function checkedApproval(input: ProjectApproval): JsonObject {
  ensure(
    input.kind === "user-decision" || input.kind === "user-message",
    "invalid-project-approval-kind",
  );
  return { kind: input.kind, ref: workText(input.ref, "invalid-project-approval-ref") };
}

function sameApproval(existing: ProjectApproval, input: ProjectApproval): boolean {
  return existing.kind === input.kind && existing.ref === input.ref;
}

export function isClosedProjectTask(state: ProjectTaskState): state is ClosedProjectTaskState {
  return state === "declined" || state === "cancelled";
}

export {
  change as appendProjectTaskTransition,
  bound as assertBoundProjectTaskActor,
  checkedApproval as checkProjectTaskApproval,
  duplicate as duplicateProjectTask,
  requiredTask as requireProjectTask,
  sameApproval as sameProjectTaskApproval,
};

/** Record the exact human decision after the command checks the approval recorder. */
export function approveProjectTask(
  store: Store,
  actor: Actor,
  id: string,
  input: ProjectApproval,
): TaskWrite {
  bound(actor);
  const approval = checkedApproval(input);
  return store.transaction(() => {
    const task = requiredTask(store.db, id);
    ensure(!isClosedProjectTask(task.state), "project-task-closed");
    if (task.approval !== null) {
      ensure(sameApproval(task.approval, input), "project-task-approval-conflict");
      return duplicate(task);
    }
    ensure(task.state === "proposed", "project-task-not-proposed");
    return change(store, actor, EVENT.approved, task, { approval });
  });
}

export function startProjectTask(store: Store, actor: Actor, id: string): TaskWrite {
  bound(actor);
  return store.transaction(() => {
    const task = requiredTask(store.db, id);
    ensure(task.owner === actor.role, "not-owner");
    ensure(!isClosedProjectTask(task.state), "project-task-closed");
    if (task.start !== null) {
      return duplicate(task);
    }
    ensure(task.state === "approved", "project-task-not-approved");
    ensure(
      task.dependsOn.every((dependency) => requiredTask(store.db, dependency).state === "landed"),
      "project-task-dependency-unlanded",
    );
    return change(store, actor, EVENT.started, task);
  });
}

function checkedCandidate(candidate: ProjectTaskCandidate): JsonObject {
  const { baseSha, headSha, policySha, review, targetPolicySha } = candidate;
  ensure(
    FULL_SHA.test(baseSha) && FULL_SHA.test(headSha) && baseSha !== headSha,
    "invalid-project-task-sha",
  );
  ensure(SHA256.test(policySha), "invalid-project-policy-sha");
  ensure(
    targetPolicySha === undefined || SHA256.test(targetPolicySha),
    "invalid-project-target-policy-sha",
  );
  ensure(review === "off" || review === "chat" || review === "pr", "invalid-project-review-policy");
  return {
    baseSha,
    branch: workText(candidate.branch, "invalid-project-task-branch"),
    evidence: workText(candidate.evidence, "invalid-project-task-evidence"),
    headSha,
    policySha,
    review,
    summary: workText(candidate.summary, "invalid-project-task-summary"),
    ...(targetPolicySha === undefined ? {} : { targetPolicySha }),
  };
}

export function readyProjectTask(
  store: Store,
  actor: Actor,
  id: string,
  input: ProjectTaskCandidate,
  refreshPolicy = false,
): TaskWrite {
  bound(actor);
  const candidate = checkedCandidate(input);
  return store.transaction(() => {
    const task = requiredTask(store.db, id);
    ensure(task.owner === actor.role, "not-owner");
    ensure(!isClosedProjectTask(task.state), "project-task-closed");
    const previous = task.candidate;
    if (previous?.headSha === input.headSha) {
      if (canonicalJson(previous) === canonicalJson(candidate)) {
        return duplicate(task);
      }
      ensure(
        refreshPolicy &&
          previous.policySha !== input.policySha &&
          previous.baseSha === input.baseSha &&
          previous.branch === input.branch,
        "project-candidate-conflict",
      );
      ensure(task.state === "ready", "project-task-not-ready");
      // A policy can recur for the same head, so its digest is not an attempt identity.
      return change(
        store,
        actor,
        EVENT.ready,
        task,
        { candidate, policyRefresh: true },
        `${input.headSha}:${store.head().seq + 1}`,
      );
    }
    ensure(!refreshPolicy, "project-policy-refresh-head-mismatch");
    ensure(
      task.state === "in-progress" || task.state === "ready" || task.state === "merged",
      "project-task-not-started",
    );
    return change(store, actor, EVENT.ready, task, { candidate }, input.headSha);
  });
}

function candidateFor(task: ProjectTask, headSha: string): ProjectTaskCandidate {
  ensure(!isClosedProjectTask(task.state), "project-task-closed");
  ensure(FULL_SHA.test(headSha), "invalid-project-task-sha");
  ensure(task.candidate?.headSha === headSha, "project-candidate-stale");
  return task.candidate;
}

function revisionOf(task: ProjectTask): string {
  ensure(task.candidateRevision !== null, "project-candidate-revision-missing");
  return task.candidateRevision;
}

function attemptKey(task: ProjectTask, headSha: string): string {
  return task.requiresRevisionApproval ? `revision:${revisionOf(task)}` : headSha;
}

function requireFreshApproval(store: Store, task: ProjectTask, headSha: string, ref: string): void {
  const previous = store.db
    .prepare(
      `SELECT 1 FROM events
              WHERE kind = ? AND json_extract(payload, '$.id') = ?
                AND json_extract(payload, '$.headSha') = ?
                AND json_extract(payload, '$.approval.ref') = ?
              LIMIT 1`,
    )
    .get(EVENT.reviewApproved, task.id, headSha, ref);
  ensure(previous === undefined, "project-review-approval-reused");
}

export function approveProjectReview(
  store: Store,
  actor: Actor,
  id: string,
  headSha: string,
  input: ProjectApproval,
  revision?: string,
): TaskWrite {
  bound(actor);
  const approval = checkedApproval(input);
  return store.transaction(() => {
    const task = requiredTask(store.db, id);
    ensure(candidateFor(task, headSha).review !== "off", "project-review-disabled");
    if (task.requiresRevisionApproval || revision !== undefined) {
      ensure(revision === revisionOf(task), "project-candidate-revision-mismatch");
    }
    if (task.reviewApproval !== null) {
      ensure(sameApproval(task.reviewApproval, input), "project-review-approval-conflict");
      return duplicate(task);
    }
    ensure(task.state === "ready", "project-task-not-ready");
    if (task.requiresRevisionApproval) {
      requireFreshApproval(store, task, headSha, input.ref);
    }
    return change(
      store,
      actor,
      EVENT.reviewApproved,
      task,
      { approval, headSha },
      attemptKey(task, headSha),
    );
  });
}

export function linkProjectReview(
  store: Store,
  actor: Actor,
  id: string,
  headSha: string,
  input: ProjectReviewLink,
): TaskWrite {
  bound(actor);
  ensure(Number.isSafeInteger(input.number) && input.number > 0, "invalid-project-review-number");
  const url = workText(input.url, "invalid-project-review-url");
  return store.transaction(() => {
    const task = requiredTask(store.db, id);
    ensure(candidateFor(task, headSha).review === "pr", "project-review-not-pr");
    if (task.reviewRequest !== null) {
      ensure(
        task.reviewRequest.number === input.number && task.reviewRequest.url === url,
        "project-review-link-conflict",
      );
      return duplicate(task);
    }
    ensure(task.state === "ready", "project-task-not-ready");
    return change(
      store,
      actor,
      EVENT.reviewLinked,
      task,
      { headSha, number: input.number, url },
      attemptKey(task, headSha),
    );
  });
}

export function mergeProjectTask(
  store: Store,
  actor: Actor,
  id: string,
  headSha: string,
  landedSha: string,
): TaskWrite {
  bound(actor);
  ensure(FULL_SHA.test(landedSha), "invalid-project-task-sha");
  return store.transaction(() => {
    const task = requiredTask(store.db, id);
    const { review } = candidateFor(task, headSha);
    if (task.mergedSha !== null) {
      ensure(task.mergedSha === landedSha, "project-merge-conflict");
      return duplicate(task);
    }
    ensure(task.state === "ready", "project-task-not-ready");
    if (review === "chat") {
      ensure(
        task.reviewApproval?.candidateRevision === revisionOf(task),
        "project-review-not-approved",
      );
    }
    if (review === "pr") {
      ensure(
        task.reviewRequest?.candidateRevision === revisionOf(task),
        "project-review-not-linked",
      );
    }
    return change(
      store,
      actor,
      EVENT.merged,
      task,
      { headSha, landedSha },
      attemptKey(task, headSha),
    );
  });
}

export function landProjectTask(
  store: Store,
  actor: Actor,
  id: string,
  headSha: string,
  landedSha: string,
  evidenceRef: string,
): TaskWrite {
  bound(actor);
  const evidence = workText(evidenceRef, "invalid-project-landing-evidence");
  return store.transaction(() => {
    const task = requiredTask(store.db, id);
    candidateFor(task, headSha);
    ensure(task.mergedSha !== null && task.mergedSha === landedSha, "project-merge-stale");
    if (task.landingEvidence !== null) {
      ensure(task.landingEvidence === evidence, "project-landing-conflict");
      return duplicate(task);
    }
    ensure(task.state === "merged", "project-task-not-merged");
    return change(
      store,
      actor,
      EVENT.landed,
      task,
      { evidence, headSha, landedSha },
      attemptKey(task, headSha),
    );
  });
}
