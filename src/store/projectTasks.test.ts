import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TEST_CLOCK } from "../core/testFixtures.ts";
import { MEMORY, Store } from "./db.ts";
import { prepareCompactionCheckpoint } from "./files/compactionCheckpoint.ts";
import { fileRecords } from "./files/records.ts";
import {
  approveProjectReview,
  approveProjectTask,
  landProjectTask,
  linkProjectReview,
  listProjectTasks,
  mergeProjectTask,
  type ProjectReviewPolicy,
  proposeProjectTask,
  readProjectTask,
  readyProjectTask,
  startProjectTask,
} from "./projectTasks.ts";

const MAINTAINER = { nativeId: "00000000-0000-4000-8000-000000000001", role: "maintainer" };
const OWNER = { nativeId: "00000000-0000-4000-8000-000000000002", role: "builder" };
const APPROVAL = { kind: "user-decision", ref: "conversation:fixture/decision-1" } as const;
const REVIEW_APPROVAL = { kind: "user-message", ref: "conversation:fixture/message-2" } as const;
const BASE = "a".repeat(40);
const FIRST = "b".repeat(40);
const SECOND = "c".repeat(40);
const MERGED = "d".repeat(40);
const EVIDENCE = "check:fixture/1";

function proposal(id: string, dependsOn: readonly string[] = []) {
  return { dependsOn, id, owner: OWNER.role, scope: "Implement the fixture", title: "Fixture" };
}

function candidate(headSha = FIRST, review: ProjectReviewPolicy = "chat") {
  return {
    baseSha: BASE,
    branch: "fixture/branch",
    evidence: EVIDENCE,
    headSha,
    policySha: "e".repeat(64),
    review,
    summary: "Exact candidate",
  };
}

function begin(store: Store, id: string): void {
  proposeProjectTask(store, MAINTAINER, proposal(id));
  approveProjectTask(store, MAINTAINER, id, APPROVAL);
  startProjectTask(store, OWNER, id);
}

describe("standalone project tasks", () => {
  let store: Store;
  beforeEach(() => {
    store = Store.open(TEST_CLOCK, MEMORY);
  });
  afterEach(() => store.close());

  it("records an exact user approval and refuses starts by another role or before dependencies land", () => {
    proposeProjectTask(store, MAINTAINER, proposal("first"));
    expect(() =>
      proposeProjectTask(store, { nativeId: null, role: OWNER.role }, proposal("unbound")),
    ).toThrow("invalid-project-task-actor");
    expect(() => proposeProjectTask(store, MAINTAINER, proposal("cycle", ["cycle"]))).toThrow(
      "invalid-project-task-dependency",
    );
    expect(() => startProjectTask(store, OWNER, "first")).toThrow("project-task-not-approved");
    const input = proposal("second", ["first"]);
    expect(proposeProjectTask(store, MAINTAINER, input).task.state).toBe("proposed");
    expect(proposeProjectTask(store, MAINTAINER, input).duplicate).toBe(true);
    expect(() =>
      proposeProjectTask(store, MAINTAINER, { ...input, scope: "Changed scope" }),
    ).toThrow("project-task-id-conflict");
    expect(approveProjectTask(store, MAINTAINER, "second", APPROVAL).task).toMatchObject({
      approval: { ...APPROVAL, actor: MAINTAINER },
      state: "approved",
    });
    expect(() => approveProjectTask(store, MAINTAINER, "second", REVIEW_APPROVAL)).toThrow(
      "project-task-approval-conflict",
    );
    expect(() => startProjectTask(store, MAINTAINER, "second")).toThrow("not-owner");
    expect(() => startProjectTask(store, OWNER, "second")).toThrow(
      "project-task-dependency-unlanded",
    );
    approveProjectTask(store, MAINTAINER, "first", APPROVAL);
    startProjectTask(store, OWNER, "first");
    readyProjectTask(store, OWNER, "first", candidate(FIRST, "off"));
    mergeProjectTask(store, OWNER, "first", FIRST, MERGED);
    landProjectTask(store, MAINTAINER, "first", FIRST, MERGED, EVIDENCE);
    expect(startProjectTask(store, OWNER, "second").task).toMatchObject({
      start: { actor: OWNER },
      state: "in-progress",
    });
    expect(listProjectTasks(store.db).map(({ id }) => id)).toEqual(["first", "second"]);
  });

  it("binds approval to the exact chat candidate and clears prior evidence when a merged task is revised", () => {
    begin(store, "change");
    expect(() => readyProjectTask(store, MAINTAINER, "change", candidate())).toThrow("not-owner");
    expect(() =>
      readyProjectTask(store, OWNER, "change", { ...candidate(), policySha: "short" }),
    ).toThrow("invalid-project-policy-sha");
    readyProjectTask(store, OWNER, "change", candidate());
    expect(readyProjectTask(store, OWNER, "change", candidate()).duplicate).toBe(true);
    expect(() =>
      readyProjectTask(store, OWNER, "change", { ...candidate(), policySha: "f".repeat(64) }),
    ).toThrow("project-candidate-conflict");
    expect(() => mergeProjectTask(store, OWNER, "change", FIRST, MERGED)).toThrow(
      "project-review-not-approved",
    );
    approveProjectReview(store, MAINTAINER, "change", FIRST, REVIEW_APPROVAL);
    mergeProjectTask(store, OWNER, "change", FIRST, MERGED);
    expect(readyProjectTask(store, OWNER, "change", candidate(SECOND)).task).toMatchObject({
      candidate: { headSha: SECOND },
      mergedSha: null,
      reviewApproval: null,
      reviewRequest: null,
      state: "ready",
    });
    expect(() => landProjectTask(store, OWNER, "change", FIRST, MERGED, EVIDENCE)).toThrow(
      "project-candidate-stale",
    );
    expect(() => approveProjectReview(store, MAINTAINER, "change", FIRST, REVIEW_APPROVAL)).toThrow(
      "project-candidate-stale",
    );
    expect(() => mergeProjectTask(store, OWNER, "change", SECOND, MERGED)).toThrow(
      "project-review-not-approved",
    );
    approveProjectReview(store, MAINTAINER, "change", SECOND, REVIEW_APPROVAL);
    mergeProjectTask(store, OWNER, "change", SECOND, MERGED);
    expect(() => landProjectTask(store, OWNER, "change", SECOND, BASE, EVIDENCE)).toThrow(
      "project-merge-stale",
    );
    const landed = landProjectTask(store, OWNER, "change", SECOND, MERGED, EVIDENCE).task;
    expect(landed).toMatchObject({ landingEvidence: EVIDENCE, state: "landed" });
    expect(landProjectTask(store, OWNER, "change", SECOND, MERGED, EVIDENCE).duplicate).toBe(true);
    const before = store.verify();
    store.rebuild();
    expect(store.verify()).toEqual(before);
    expect(readProjectTask(store.db, "change")).toEqual(landed);
  });

  it("requires a linked PR for a forge-verified merge and invalidates its link on revision", () => {
    begin(store, "change");
    readyProjectTask(store, OWNER, "change", candidate(FIRST, "pr"));
    const link = { number: 7, url: "https://example.invalid/project/pull/7" };
    expect(() => mergeProjectTask(store, OWNER, "change", FIRST, MERGED)).toThrow(
      "project-review-not-linked",
    );
    const linked = linkProjectReview(store, OWNER, "change", FIRST, link);
    expect(linked.task.reviewRequest).toMatchObject({ ...link, headSha: FIRST });
    expect(linkProjectReview(store, OWNER, "change", FIRST, link).duplicate).toBe(true);
    expect(mergeProjectTask(store, MAINTAINER, "change", FIRST, MERGED).task.state).toBe("merged");
    expect(
      readyProjectTask(store, OWNER, "change", candidate(SECOND, "pr")).task.reviewRequest,
    ).toBeNull();
  });

  it("projects role-owned records and restores task events unchanged through a checkpoint", () => {
    begin(store, "change");
    readyProjectTask(store, OWNER, "change", candidate(FIRST, "off"));
    mergeProjectTask(store, OWNER, "change", FIRST, MERGED);
    landProjectTask(store, OWNER, "change", FIRST, MERGED, EVIDENCE);
    const canonical = store.events();
    const registeredRoles = new Set([MAINTAINER.role, OWNER.role]);
    expect(fileRecords(canonical, { registeredRoles }).map(({ path }) => path)).toEqual(
      canonical.map(({ seq }) => `roles/${OWNER.role}/project-tasks/change/${seq}.json`),
    );
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
      expect(readProjectTask(restored.db, "change")).toEqual(readProjectTask(store.db, "change"));
      expect(restored.verify()).toEqual(store.verify());
    } finally {
      restored.close();
    }
  });
});
