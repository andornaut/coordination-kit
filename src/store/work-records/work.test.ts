import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TEST_CLOCK } from "../../core/testFixtures.ts";
import { Store } from "../db.ts";
import { planFileCompaction } from "../files/compaction/plan.ts";
import { StoreError } from "../types.ts";
import { type FinishInput, finishWork, readWorkRecord, readyWork, startWork } from "./work.ts";

const ACTOR = { nativeId: "00000000-0000-4000-8000-0000000000e1", role: "sample-kit" };
const OWNER = "sample-kit";
const ref = (id: string) => ({ id, repository: OWNER });

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), "store-work-")), "coordination");
}

function code(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof StoreError ? error.code : String(error);
  }
}

describe("work finish records", () => {
  it.each<{ name: string; input: Omit<FinishInput, "owner" | "ref">; code: string }>([
    { code: "successor-missing", input: { status: "superseded" }, name: "superseded alone" },
    {
      code: "invalid-successor",
      input: { status: "cancelled", successors: ["sk-0002"] },
      name: "a cancelled finish citing a successor",
    },
    {
      code: "invalid-successor",
      input: { status: "superseded", successors: ["sk-0001"] },
      name: "an item superseding itself",
    },
    {
      code: "invalid-successor",
      input: { status: "superseded", successors: ["not an id"] },
      name: "a malformed successor",
    },
    {
      code: "invalid-finish-status",
      input: { status: "approved" as never },
      name: "an open status",
    },
  ])("refuses $name", ({ code: expected, input }) => {
    const store = Store.open(TEST_CLOCK, scratch());
    try {
      expect(
        code(() => finishWork(store, ACTOR, { ...input, owner: OWNER, ref: ref("sk-0001") })),
      ).toBe(expected);
      expect(readWorkRecord(store, ref("sk-0001"))).toBeNull();
    } finally {
      store.close();
    }
  });

  it("rebuilds finish statuses and successors from the events", () => {
    const path = scratch();
    const store = Store.open(TEST_CLOCK, path);
    for (const id of ["sk-0001", "sk-0002", "sk-0003"]) {
      startWork(store, ACTOR, { owner: OWNER, parent: null, ref: ref(id) });
      readyWork(store, ACTOR, { ref: ref(id) });
    }
    finishWork(store, ACTOR, { owner: OWNER, ref: ref("sk-0001") });
    finishWork(store, ACTOR, {
      owner: OWNER,
      ref: ref("sk-0002"),
      status: "superseded",
      successors: ["sk-0005", "sk-0004", "sk-0005"],
    });
    finishWork(store, ACTOR, { owner: OWNER, ref: ref("sk-0003"), status: "cancelled" });
    const records = () =>
      ["sk-0001", "sk-0002", "sk-0003"].map((id) => readWorkRecord(store, ref(id)));
    const before = records();
    expect(
      before.map((record) => [record?.state, record?.finishedStatus, record?.successors]),
    ).toEqual([
      ["finished", "done", []],
      ["finished", "superseded", ["sk-0004", "sk-0005"]],
      ["finished", "cancelled", []],
    ]);
    for (const id of ["sk-0001", "sk-0002", "sk-0003"]) {
      store.index.remove("work", [OWNER, id]);
    }
    expect(store.rebuild().events).toBe(store.events().length);
    expect(records()).toEqual(before);
    store.close();
    const reopened = Store.open(TEST_CLOCK, path);
    expect(reopened.verify().events).toBe(reopened.events().length);
    expect(readWorkRecord(reopened, ref("sk-0002"))).toEqual(before[1]);
    // Compaction keeps every work event, whatever its payload fields.
    const plan = planFileCompaction(reopened.events(), {
      registeredGames: new Set(),
      registeredRoles: new Set([OWNER]),
      registryRevision: 1,
    });
    expect(plan.streams.find((stream) => stream.source === "work.finished")).toMatchObject({
      eligible: { count: 0 },
      protected: [{ count: 3, reason: "protected-event-kind" }],
    });
    reopened.close();
  });
});
