import type { Store } from "../db.ts";
import { type Actor, ensure } from "../types.ts";
import { workText } from "../work-records/work.ts";
import {
  appendProjectTaskTransition,
  assertBoundProjectTaskActor,
  checkProjectTaskApproval,
  type ClosedProjectTaskState,
  duplicateProjectTask,
  isClosedProjectTask,
  PROJECT_TASK_DISPOSITIONS,
  type ProjectApproval,
  requireProjectTask,
  sameProjectTaskApproval,
} from "./tasks.ts";

interface TaskClosure {
  readonly approval: ProjectApproval;
  readonly reason: string;
  readonly state: ClosedProjectTaskState;
}

interface DependencyReplacement {
  readonly approval: ProjectApproval;
  readonly dependency: string;
  readonly replacement: string;
}

function checkedDecision(input: ProjectApproval) {
  ensure(input.kind === "user-decision", "invalid-project-approval-kind");
  return checkProjectTaskApproval(input);
}

/** The command verifies maintainer authority and that a ready candidate is unmerged. */
export function closeProjectTask(store: Store, actor: Actor, id: string, input: TaskClosure) {
  assertBoundProjectTaskActor(actor);
  const approval = checkedDecision(input.approval);
  const reason = workText(input.reason, "invalid-project-task-closure-reason");
  ensure(isClosedProjectTask(input.state), "invalid-project-task-closure-state");
  return store.transaction(() => {
    const task = requireProjectTask(store.db, id);
    if (task.closure !== undefined) {
      ensure(
        task.state === input.state &&
          task.closure.actor.role === actor.role &&
          task.closure.reason === reason &&
          sameProjectTaskApproval(task.closure, input.approval),
        "project-task-closure-conflict",
      );
      return duplicateProjectTask(task);
    }
    if (input.state === "declined") {
      ensure(task.state === "proposed", "project-task-not-proposed");
    } else {
      ensure(
        task.mergedSha === null &&
          (task.state === "approved" || task.state === "in-progress" || task.state === "ready"),
        "project-task-not-cancellable",
      );
    }
    return appendProjectTaskTransition(store, actor, PROJECT_TASK_DISPOSITIONS.closed, task, {
      approval,
      reason,
      state: input.state,
    });
  });
}

function assertAcyclicReplacement(store: Store, id: string, replacement: string): void {
  // A Set visits newly added dependencies once, including when stored edges converge.
  const pending = new Set([replacement]);
  for (const dependency of pending) {
    ensure(dependency !== id, "project-task-dependency-cycle");
    for (const child of requireProjectTask(store.db, dependency).dependsOn) {
      pending.add(child);
    }
  }
}

/** An explicit replacement transfers the start requirement to the new task. */
export function replaceProjectDependency(
  store: Store,
  actor: Actor,
  id: string,
  input: DependencyReplacement,
) {
  assertBoundProjectTaskActor(actor);
  const approval = checkedDecision(input.approval);
  const { dependency, replacement } = input;
  return store.transaction(() => {
    const task = requireProjectTask(store.db, id);
    const previous = task.dependencyReplacements?.find((entry) => entry.dependency === dependency);
    if (previous !== undefined) {
      ensure(
        previous.replacement === replacement &&
          previous.actor.role === actor.role &&
          sameProjectTaskApproval(previous, input.approval),
        "project-task-dependency-replacement-conflict",
      );
      return duplicateProjectTask(task);
    }
    ensure(
      task.start === null && (task.state === "proposed" || task.state === "approved"),
      "project-task-dependencies-immutable",
    );
    ensure(task.dependsOn.includes(dependency), "project-task-dependency-not-declared");
    ensure(
      isClosedProjectTask(requireProjectTask(store.db, dependency).state),
      "project-task-dependency-not-closed",
    );
    ensure(!task.dependsOn.includes(replacement), "duplicate-project-task-dependency");
    ensure(
      !isClosedProjectTask(requireProjectTask(store.db, replacement).state),
      "project-task-replacement-closed",
    );
    assertAcyclicReplacement(store, id, replacement);
    const dependsOn = task.dependsOn
      .map((current) => (current === dependency ? replacement : current))
      .sort();
    return appendProjectTaskTransition(
      store,
      actor,
      PROJECT_TASK_DISPOSITIONS.dependencyReplaced,
      task,
      { approval, dependency, dependsOn, replacement },
      dependency,
    );
  });
}
