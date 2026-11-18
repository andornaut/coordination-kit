import { describe, expect, it } from "vitest";

import {
  checkClaim,
  checkEnroll,
  checkMessagePublish,
  checkMessageReceipt,
  checkWorkAccept,
  checkWorkPublish,
  checkWorkReceipt,
  checkWorkSubmit,
  locateIssue,
} from "./protocol-input.ts";

const AT = "2026-11-16T04:00:00.000Z";
const UUID = "00000000-0000-4000-8000-000000000001";
const WORKER = "00000000-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);
const ARTIFACT = { hash: HASH, size: 1 };
const BINDING = { harness: "claude", nativeId: UUID };
const context = (role = "coordinator") => ({
  at: AT,
  binding: BINDING,
  epoch: 1,
  expectedRevision: 1,
  id: "transaction-one",
  role,
});
const definition = {
  artifacts: [ARTIFACT],
  clauseIds: [],
  criteria: [{ consumers: [], id: "check", phases: ["execution", "check"], targetId: "target" }],
  id: "work-one",
  messageIds: [],
  plan: { ...ARTIFACT, commit: "b".repeat(40), path: "docs/work/ck-0001.md" },
  requestIds: ["request-one"],
  retention: null,
  source: null,
};
const receipt = {
  artifact: ARTIFACT,
  consumer: null,
  criterionId: "check",
  definitionHash: HASH,
  id: "receipt-one",
  outcome: "passed",
  phase: "check",
  source: null,
  workId: "work-one",
};
const guards = { artifacts: [], hold: "unknown", question: "unknown", references: [] };
const original = { hash: HASH, messageId: "message-one", revision: 1, senderRole: "kits/game-kit" };

describe("protocol input checks", () => {
  it("accepts the inputs the stores accept", () => {
    const valid = [
      checkWorkPublish({
        context: context(),
        input: { definition, expectedWorkRevision: 0, ready: false, replaces: null },
      }),
      checkWorkReceipt({
        context: context(),
        input: { expectedWorkRevision: 1, receipt, workId: "work-one" },
      }),
      checkWorkSubmit({
        context: {
          ...context(`coordinator/workers/${WORKER}/1`),
          binding: { ...BINDING, nativeId: WORKER },
        },
        input: {
          artifacts: [ARTIFACT],
          criterionIds: ["check"],
          definitionHash: HASH,
          id: "submission-one",
          parentEpoch: 1,
          parentRole: "coordinator",
          receipts: [receipt],
          source: null,
          workerId: WORKER,
          workId: "work-one",
        },
      }),
      checkWorkAccept({
        context: context(),
        input: {
          evidence: ARTIFACT,
          expectedWorkRevision: 1,
          submission: {
            artifact: ARTIFACT,
            id: "submission-one",
            revision: 1,
            role: "coordinator",
          },
          workId: "work-one",
        },
      }),
      checkMessagePublish({
        input: {
          envelope: {
            body: "",
            created: AT,
            fromRole: "game-coordinator",
            id: "message-one",
            intent: "queue",
            schema: 1,
            toRole: "archies-dog-walks/tech",
          },
          guards,
          links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
        },
        writer: context(),
      }),
      checkMessageReceipt({
        input: {
          disposition: "retained",
          evidence: [ARTIFACT],
          guards,
          id: "handled-one",
          original,
          retention: { nextBoundary: "next review", ownerRole: "coordinator", reason: "held" },
        },
        writer: context("kits/game-kit"),
      }),
      checkClaim({
        at: AT,
        binding: BINDING,
        evidence: "fixture",
        expectedEpoch: 0,
        role: "coordinator",
      }),
      checkClaim({
        at: AT,
        binding: { ...BINDING, nativeId: WORKER },
        evidence: "fixture",
        expectedEpoch: 0,
        parent: { epoch: 1, role: "coordinator", workerId: WORKER },
        role: `coordinator/workers/${WORKER}/1`,
      }),
      checkEnroll({
        context: context(),
        input: {
          evidence: [ARTIFACT],
          generation: 1,
          inspectedAt: AT,
          ledger: { hash: null, revision: 0 },
          phase: "active",
          references: [{ key: "request-one", kind: "request" }],
          registryRevision: 1,
          unknowns: [],
          workspaceId: "fixture",
        },
      }),
    ];
    for (const check of valid) {
      expect(check).toMatchObject({ fatal: null, issues: [] });
    }
  });

  it("reports envelope keys before the store and field issues with store codes", () => {
    expect(checkWorkPublish({ input: {}, writer: context() }).fatal).toEqual({
      code: "invalid-input",
      path: "/context",
      rule: "required",
    });
    expect(checkMessagePublish({ context: context(), input: {} }).fatal).toMatchObject({
      path: "/writer",
    });
    expect(checkWorkPublish([]).fatal).toMatchObject({ path: "", rule: "type" });
    expect(checkWorkPublish({ context: { ...context(), role: 7 }, input: {} }).fatal).toMatchObject(
      { path: "/context/role", rule: "type" },
    );
    const check = checkWorkReceipt({
      context: { ...context(), epoch: 0 },
      input: {
        expectedWorkRevision: 1,
        receipt: { ...receipt, outcome: "done", phase: "review" },
        workId: "work-one",
      },
    });
    expect(check.issues).toEqual([
      { code: "invalid-transaction", path: "/context/epoch", rule: "range" },
      { code: "invalid-receipt", path: "/input/receipt/outcome", rule: "enum" },
      { code: "receipt-scope-mismatch", path: "/input/receipt/phase", rule: "enum" },
    ]);
    expect(locateIssue(check, "receipt-scope-mismatch")?.path).toBe("/input/receipt/phase");
    expect(locateIssue(check, "stale-work")).toEqual({
      code: "stale-work",
      path: "/input/expectedWorkRevision",
      rule: "mismatch",
    });
    expect(locateIssue(check, "writer-fenced")).toBeUndefined();
  });

  it("names only field-like unexpected keys", () => {
    const check = checkClaim({
      "a/b": 1,
      at: AT,
      binding: BINDING,
      evidence: "",
      expectedEpoch: -1,
      "not a field name": 2,
      role: "coordinator",
    });
    expect(check.issues).toEqual([
      { code: "invalid-claim", path: "", rule: "unexpected-key" },
      { code: "invalid-claim", path: "", rule: "unexpected-key" },
      { code: "invalid-claim", path: "/expectedEpoch", rule: "range" },
      { code: "invalid-claim", path: "/evidence", rule: "empty" },
    ]);
    expect(
      checkWorkPublish({
        context: context(),
        input: {
          definition: { ...definition, plan: { ...ARTIFACT, "x~y": 1 } },
          ready: false,
        },
      }).issues,
    ).toEqual([{ code: "invalid-work", path: "/input/definition/plan", rule: "unexpected-key" }]);
  });

  it("mirrors coercing ID checks and cross-field rules", () => {
    const numeric = checkWorkPublish({
      context: context(),
      input: { definition: { ...definition, id: 7 }, ready: false },
    });
    expect(numeric.issues).toEqual([
      { code: "invalid-transaction", path: "/input/definition/id", rule: "type" },
    ]);
    const submit = checkWorkSubmit({
      context: context(),
      input: {
        artifacts: [],
        criterionIds: ["check"],
        definitionHash: HASH,
        id: "submission-one",
        parentEpoch: 1,
        parentRole: "game-coordinator",
        receipts: [
          { ...receipt, id: 5 },
          { ...receipt, id: 5, phase: "acceptance", source: { ...ARTIFACT } },
        ],
        source: null,
        workerId: WORKER,
        workId: "work-one",
      },
    });
    expect(submit.issues).toEqual([
      { code: "invalid-role", path: "/input/parentRole", rule: "format" },
      { code: "submission-scope-mismatch", path: "/input/receipts/1/phase", rule: "enum" },
      { code: "receipt-source-mismatch", path: "/input/receipts/1/source", rule: "mismatch" },
      { code: "invalid-work", path: "/input/receipts/1/source/base", rule: "required" },
      { code: "invalid-work", path: "/input/receipts/1/source/commit", rule: "required" },
      { code: "invalid-work", path: "/input/receipts/1/source/tree", rule: "required" },
      { code: "invalid-work", path: "/input/receipts/1/source/dependencies", rule: "required" },
      { code: "invalid-work", path: "/input/receipts/1/source/hash", rule: "unexpected-key" },
      { code: "invalid-work", path: "/input/receipts/1/source/size", rule: "unexpected-key" },
      { code: "receipt-exists", path: "/input/receipts/1", rule: "duplicate" },
    ]);
  });
});
