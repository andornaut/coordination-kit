import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TEST_CLOCK } from "../../core/testFixtures.ts";
import { MEMORY, Store } from "../db.ts";
import { prepareCompactionCheckpoint } from "../files/compaction/checkpoint.ts";
import { fileRecords } from "../files/records.ts";
import { closeProjectTask, replaceProjectDependency } from "./dependencies.ts";
import {
  approveProjectTask,
  landProjectTask,
  mergeProjectTask,
  proposeProjectTask,
  readProjectTask,
  readyProjectTask,
  startProjectTask,
} from "./tasks.ts";

const MAINTAINER = { nativeId: "00000000-0000-4000-8000-000000000001", role: "maintainer" };
const OWNER = { nativeId: "00000000-0000-4000-8000-000000000002", role: "builder" };
const APPROVAL = { kind: "user-decision", ref: "conversation:fixture/approval" } as const;
const CLOSE = {
  approval: { ...APPROVAL, ref: "conversation:fixture/closure" },
  reason: "The user withdrew this task",
  state: "declined",
} as const;
const REPLACE = {
  approval: { ...APPROVAL, ref: "conversation:fixture/substitution" },
  dependency: "original",
  replacement: "replacement",
} as const;
const CANDIDATE = {
  baseSha: "a".repeat(40),
  branch: "fixture/change",
  evidence: "check:fixture/1",
  headSha: "b".repeat(40),
  policySha: "e".repeat(64),
  review: "off",
  summary: "Exact candidate",
} as const;

function proposal(id: string, dependsOn: readonly string[] = []) {
  return { dependsOn, id, owner: OWNER.role, scope: "Implement fixture", title: "Fixture" };
}

describe("standalone project task dispositions", () => {
  let store: Store;
  beforeEach(() => {
    store = Store.open(TEST_CLOCK, MEMORY);
  });
  afterEach(() => store.close());

  function propose(id: string, dependsOn?: readonly string[]) {
    return proposeProjectTask(store, MAINTAINER, proposal(id, dependsOn));
  }

  function approve(id: string) {
    return approveProjectTask(store, MAINTAINER, id, APPROVAL);
  }

  function ready(id: string) {
    startProjectTask(store, OWNER, id);
    return readyProjectTask(store, OWNER, id, CANDIDATE);
  }

  function merge(id: string) {
    return mergeProjectTask(store, MAINTAINER, id, CANDIDATE.headSha, CANDIDATE.headSha);
  }

  function land(id: string) {
    return landProjectTask(
      store,
      MAINTAINER,
      id,
      CANDIDATE.headSha,
      CANDIDATE.headSha,
      CANDIDATE.evidence,
    );
  }

  it("declines only proposals with a bound recorder, exact decision, and reason", () => {
    propose("original");
    const cancel = { ...CLOSE, state: "cancelled" } as const;
    expect(() => closeProjectTask(store, MAINTAINER, "original", cancel)).toThrow(
      "project-task-not-cancellable",
    );
    expect(() =>
      closeProjectTask(store, { ...MAINTAINER, nativeId: null }, "original", CLOSE),
    ).toThrow("invalid-project-task-actor");
    expect(() =>
      closeProjectTask(store, MAINTAINER, "original", {
        ...CLOSE,
        approval: { ...CLOSE.approval, kind: "user-message" },
      }),
    ).toThrow("invalid-project-approval-kind");
    expect(() => closeProjectTask(store, MAINTAINER, "original", { ...CLOSE, reason: "" })).toThrow(
      "invalid-project-task-closure-reason",
    );
    const closed = closeProjectTask(store, MAINTAINER, "original", CLOSE);
    expect(closed).toMatchObject({
      duplicate: false,
      task: {
        closure: { ...CLOSE.approval, actor: MAINTAINER, reason: CLOSE.reason },
        state: "declined",
      },
    });
    expect(closeProjectTask(store, MAINTAINER, "original", CLOSE)).toEqual({
      duplicate: true,
      task: closed.task,
    });
    expect(() => closeProjectTask(store, OWNER, "original", CLOSE)).toThrow(
      "project-task-closure-conflict",
    );
    expect(() => approve("original")).toThrow("project-task-closed");
  });

  it.each(["approved", "in-progress", "ready"] as const)(
    "cancels %s work and prevents further progress",
    (state) => {
      propose("change");
      approve("change");
      if (state === "in-progress") {
        startProjectTask(store, OWNER, "change");
      }
      if (state === "ready") {
        ready("change");
      }
      expect(() => closeProjectTask(store, MAINTAINER, "change", CLOSE)).toThrow(
        "project-task-not-proposed",
      );
      expect(
        closeProjectTask(store, MAINTAINER, "change", { ...CLOSE, state: "cancelled" }).task.state,
      ).toBe("cancelled");
      expect(() => startProjectTask(store, OWNER, "change")).toThrow("project-task-closed");
      expect(() => readyProjectTask(store, OWNER, "change", CANDIDATE)).toThrow(
        "project-task-closed",
      );
      expect(() => merge("change")).toThrow("project-task-closed");
    },
  );

  it("refuses to cancel merged and landed candidates", () => {
    propose("change");
    approve("change");
    ready("change");
    merge("change");
    const cancel = { ...CLOSE, state: "cancelled" } as const;
    expect(() => closeProjectTask(store, MAINTAINER, "change", cancel)).toThrow(
      "project-task-not-cancellable",
    );
    land("change");
    expect(() => closeProjectTask(store, MAINTAINER, "change", cancel)).toThrow(
      "project-task-not-cancellable",
    );
  });

  it("moves the start gate to the explicit replacement while preserving the original proposal", () => {
    propose("original");
    propose("replacement");
    propose("other");
    propose("change", ["original"]);
    expect(() => replaceProjectDependency(store, MAINTAINER, "change", REPLACE)).toThrow(
      "project-task-dependency-not-closed",
    );
    closeProjectTask(store, MAINTAINER, "original", CLOSE);
    approve("change");
    expect(() => startProjectTask(store, OWNER, "change")).toThrow(
      "project-task-dependency-unlanded",
    );
    const replaced = replaceProjectDependency(store, MAINTAINER, "change", REPLACE).task;
    expect(replaced).toMatchObject({
      dependencyReplacements: [
        {
          ...REPLACE.approval,
          actor: MAINTAINER,
          dependency: "original",
          replacement: "replacement",
        },
      ],
      dependsOn: ["replacement"],
      state: "approved",
    });
    expect(propose("change", ["original"]).duplicate).toBe(true);
    expect(() => propose("change", ["replacement"])).toThrow("project-task-id-conflict");
    expect(() =>
      replaceProjectDependency(store, MAINTAINER, "change", { ...REPLACE, replacement: "other" }),
    ).toThrow("project-task-dependency-replacement-conflict");
    expect(() => startProjectTask(store, OWNER, "change")).toThrow(
      "project-task-dependency-unlanded",
    );
    approve("replacement");
    ready("replacement");
    merge("replacement");
    land("replacement");
    expect(startProjectTask(store, OWNER, "change").task.state).toBe("in-progress");
    expect(replaceProjectDependency(store, MAINTAINER, "change", REPLACE).duplicate).toBe(true);
    expect(() =>
      replaceProjectDependency(store, MAINTAINER, "change", {
        ...REPLACE,
        dependency: "replacement",
        replacement: "other",
      }),
    ).toThrow("project-task-dependencies-immutable");
  });

  it("rejects a duplicate, closed, missing, self, and transitively cyclic replacement", () => {
    propose("original");
    closeProjectTask(store, MAINTAINER, "original", CLOSE);
    propose("closed");
    closeProjectTask(store, MAINTAINER, "closed", CLOSE);
    propose("already");
    propose("change", ["original", "already"]);
    propose("middle", ["change"]);
    propose("cycle", ["middle"]);
    const replace = (replacement: string) =>
      replaceProjectDependency(store, MAINTAINER, "change", { ...REPLACE, replacement });
    expect(() => replace("already")).toThrow("duplicate-project-task-dependency");
    expect(() => replace("closed")).toThrow("project-task-replacement-closed");
    expect(() => replace("missing")).toThrow("project-task-missing");
    expect(() => replace("change")).toThrow("project-task-dependency-cycle");
    expect(() => replace("cycle")).toThrow("project-task-dependency-cycle");
    expect(() =>
      replaceProjectDependency(store, MAINTAINER, "change", { ...REPLACE, dependency: "closed" }),
    ).toThrow("project-task-dependency-not-declared");
    expect(readProjectTask(store.index, "change")?.dependsOn).toEqual(["already", "original"]);
  });

  it("preserves disposition events in owner records and a compaction checkpoint", () => {
    propose("original");
    propose("replacement");
    propose("change", ["original"]);
    closeProjectTask(store, MAINTAINER, "original", CLOSE);
    replaceProjectDependency(store, MAINTAINER, "change", REPLACE);
    const canonical = store.events();
    const registeredRoles = new Set([MAINTAINER.role, OWNER.role]);
    const files = fileRecords(canonical, { registeredRoles }).map(({ path }) => path);
    expect(files.slice(-2)).toEqual([
      `roles/${OWNER.role}/project-tasks/original/4.json`,
      `roles/${OWNER.role}/project-tasks/change/5.json`,
    ]);
    for (let index = 0; index < 101; index += 1) {
      store.append({
        actor: OWNER,
        key: `session.started:fixture-${index}`,
        kind: "session.started",
        payload: {
          cwd: "/synthetic/project",
          harness: "codex",
          nativeId: OWNER.nativeId,
          role: OWNER.role,
          version: "0.0.0",
        },
      });
    }
    const registryRevision = 1;
    const { checkpoint, receipt } = prepareCompactionCheckpoint(store.events(), {
      registeredGames: new Set(),
      registeredRoles,
      registryRevision,
      verifiedEvidence: {
        head: store.head(),
        messageIds: new Set(),
        registryRevision,
        routineEventSequences: new Set([canonical.length + 1]),
      },
    });
    expect(checkpoint.entries.slice(0, canonical.length)).toEqual(
      canonical.map((event) => ({ event })),
    );
    expect(checkpoint.entries[canonical.length]?.reducedDigest).toBeDefined();
    const restored = Store.openFileProjection(TEST_CLOCK, MEMORY, {
      checkpoint: { receipt, value: checkpoint },
      journal: {
        events: () => [],
        withWriter: () => {
          throw new Error("unexpected write");
        },
      },
      records: () => [],
    });
    try {
      expect(readProjectTask(restored.index, "original")).toEqual(
        readProjectTask(store.index, "original"),
      );
      expect(readProjectTask(restored.index, "change")).toEqual(
        readProjectTask(store.index, "change"),
      );
      expect(restored.verify()).toEqual(store.verify());
    } finally {
      restored.close();
    }
  });
});
