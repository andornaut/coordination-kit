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
  "proposed" | "approved" | "in-progress" | "ready" | "merged" | "landed";
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
  readonly reviewApproval: (ApprovalReceipt & { readonly headSha: string }) | null;
  readonly reviewRequest: (ProjectReviewLink & Receipt & { readonly headSha: string }) | null;
  readonly mergedSha: string | null;
  readonly landingEvidence: string | null;
  readonly updatedAt: string;
}

interface TaskWrite {
  readonly task: ProjectTask;
  readonly duplicate: boolean;
}

const TASK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EVENT = {
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

function taskRow(row: { record?: unknown } | undefined): ProjectTask | null {
  return row === undefined ? null : (JSON.parse(row.record as string) as ProjectTask);
}

export function readProjectTask(db: DatabaseSync, id: string): ProjectTask | null {
  return taskRow(db.prepare("SELECT record FROM project_tasks WHERE id = ?").get(id));
}

export function listProjectTasks(db: DatabaseSync): ProjectTask[] {
  return db
    .prepare("SELECT record FROM project_tasks ORDER BY id")
    .all()
    .map((row) => taskRow(row)!);
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
      dependsOn: payload.dependsOn as string[],
      id,
      landingEvidence: null,
      mergedSha: null,
      owner: payload.owner as string,
      proposal: receipt,
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
  const patch = taskUpdate(event.kind, payload, receipt);
  const task = { ...requiredTask(db, id), ...patch, updatedAt: event.at };
  db.prepare("UPDATE project_tasks SET record = ? WHERE id = ?").run(JSON.stringify(task), id);
}

function taskUpdate(kind: string, payload: JsonObject, receipt: Receipt): Partial<ProjectTask> {
  const approval = (payload.approval ?? {}) as JsonObject;
  const approvalReceipt = {
    ...receipt,
    kind: approval.kind as ProjectApproval["kind"],
    ref: approval.ref as string,
  };
  switch (kind) {
    case EVENT.approved:
      return { approval: approvalReceipt, state: "approved" };
    case EVENT.started:
      return { start: receipt, state: "in-progress" };
    case EVENT.ready:
      return {
        candidate: payload.candidate as unknown as ProjectTaskCandidate,
        landingEvidence: null,
        mergedSha: null,
        reviewApproval: null,
        reviewRequest: null,
        state: "ready",
      };
    case EVENT.reviewApproved:
      return { reviewApproval: { ...approvalReceipt, headSha: payload.headSha as string } };
    case EVENT.reviewLinked:
      return {
        reviewRequest: {
          ...receipt,
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
  headSha?: string,
): TaskWrite {
  const key = `${kind}:${task.id}${headSha === undefined ? "" : `:${headSha}`}`;
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
      ensure(
        task.title === title &&
          task.scope === scope &&
          task.owner === input.owner &&
          task.dependsOn.join(",") === dependsOn.join(","),
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
  const { baseSha, headSha, policySha, review } = candidate;
  ensure(
    FULL_SHA.test(baseSha) && FULL_SHA.test(headSha) && baseSha !== headSha,
    "invalid-project-task-sha",
  );
  ensure(/^[0-9a-f]{64}$/.test(policySha), "invalid-project-policy-sha");
  ensure(review === "off" || review === "chat" || review === "pr", "invalid-project-review-policy");
  return {
    baseSha,
    branch: workText(candidate.branch, "invalid-project-task-branch"),
    evidence: workText(candidate.evidence, "invalid-project-task-evidence"),
    headSha,
    policySha,
    review,
    summary: workText(candidate.summary, "invalid-project-task-summary"),
  };
}

export function readyProjectTask(
  store: Store,
  actor: Actor,
  id: string,
  input: ProjectTaskCandidate,
): TaskWrite {
  bound(actor);
  const candidate = checkedCandidate(input);
  return store.transaction(() => {
    const task = requiredTask(store.db, id);
    ensure(task.owner === actor.role, "not-owner");
    if (task.candidate?.headSha === input.headSha) {
      ensure(
        canonicalJson(task.candidate) === canonicalJson(candidate),
        "project-candidate-conflict",
      );
      return duplicate(task);
    }
    ensure(
      task.state === "in-progress" || task.state === "ready" || task.state === "merged",
      "project-task-not-started",
    );
    return change(store, actor, EVENT.ready, task, { candidate }, input.headSha);
  });
}

function candidateFor(task: ProjectTask, headSha: string): ProjectTaskCandidate {
  ensure(FULL_SHA.test(headSha), "invalid-project-task-sha");
  ensure(task.candidate?.headSha === headSha, "project-candidate-stale");
  return task.candidate;
}

export function approveProjectReview(
  store: Store,
  actor: Actor,
  id: string,
  headSha: string,
  input: ProjectApproval,
): TaskWrite {
  bound(actor);
  const approval = checkedApproval(input);
  return store.transaction(() => {
    const task = requiredTask(store.db, id);
    ensure(candidateFor(task, headSha).review !== "off", "project-review-disabled");
    if (task.reviewApproval !== null) {
      ensure(sameApproval(task.reviewApproval, input), "project-review-approval-conflict");
      return duplicate(task);
    }
    ensure(task.state === "ready", "project-task-not-ready");
    return change(store, actor, EVENT.reviewApproved, task, { approval, headSha }, headSha);
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
      headSha,
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
      ensure(task.reviewApproval?.headSha === headSha, "project-review-not-approved");
    }
    if (review === "pr") {
      ensure(task.reviewRequest?.headSha === headSha, "project-review-not-linked");
    }
    return change(store, actor, EVENT.merged, task, { headSha, landedSha }, headSha);
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
    return change(store, actor, EVENT.landed, task, { evidence, headSha, landedSha }, headSha);
  });
}
