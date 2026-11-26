import { performance } from "node:perf_hooks";

import { expect, it, vi } from "vitest";

import { TEST_CLOCK } from "../../core/testFixtures.ts";
import { collectAll } from "./collect.ts";
import { NativeTimeout, type RpcClient } from "./rpc.ts";

function recipient(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

it("reserves worker calls when question history exhausts its share", async () => {
  const deadline = performance.now() + 25_000;
  const parent = recipient(1);
  let cursor = 0;
  const call = vi.fn<RpcClient["call"]>((method) =>
    Promise.resolve(
      method === "thread/items/list" ? { data: [], nextCursor: String(++cursor) } : { data: [] },
    ),
  );
  const records = await collectAll(TEST_CLOCK, { call, close() {} }, deadline, {
    decisionRecords: {},
    parents: [parent],
    recipients: Array.from({ length: 20 }, (_, index) => recipient(index)),
    slot: 1,
  });
  expect(records.collection_budget).toMatchObject({
    calls_used: 162,
    max_calls: 256,
    reason_code: "collection_call_budget_exhausted",
  });
  expect(records.worker_health[parent]).toMatchObject({ complete: true, status: "complete" });
  expect(call.mock.calls.slice(-2)).toEqual([
    [
      "thread/list",
      expect.objectContaining({ archived: false, parentThreadId: parent }),
      expect.any(Number),
    ],
    [
      "thread/list",
      expect.objectContaining({ archived: true, parentThreadId: parent }),
      expect.any(Number),
    ],
  ]);
});

it("preserves the worker deadline after a question response times out", async () => {
  const deadline = performance.now() + 25_000;
  const parent = recipient(1);
  const call = vi.fn<RpcClient["call"]>((method) =>
    method === "thread/items/list"
      ? Promise.reject(new NativeTimeout("response"))
      : Promise.resolve({ data: [] }),
  );
  const records = await collectAll(TEST_CLOCK, { call, close() {} }, deadline, {
    decisionRecords: {},
    parents: [parent],
    recipients: [parent],
    slot: 1,
  });
  expect(records.question_state[parent]).toMatchObject({ complete: false });
  expect(records.worker_health[parent]).toMatchObject({ complete: true, status: "complete" });
  expect(call.mock.calls[0]?.[2]).toBe(deadline - 13_000);
  expect(call.mock.calls.slice(1).map(([method]) => method)).toEqual([
    "thread/list",
    "thread/list",
  ]);
  for (const [, , limit] of call.mock.calls.slice(1)) {
    expect(limit).toBeLessThan(deadline - 5000);
  }
});

it("bounds slow inventory pages while preserving a later parent's verified failure", async () => {
  const slow = recipient(1);
  const paged = recipient(2);
  const later = recipient(3);
  const child = recipient(4);
  const turn = recipient(5);
  const slowChild = recipient(6);
  const thread = {
    id: child,
    parentThreadId: later,
    status: { type: "idle" },
    updatedAt: 1,
  };
  const newest = {
    error: { codexErrorInfo: "serverOverloaded" },
    id: turn,
    status: "failed",
  };
  const slices: number[] = [];
  let now = 1000;
  const monotonic = vi.spyOn(performance, "now").mockImplementation(() => now);
  const timeOut = (deadline: number): never => {
    slices.push(deadline - now);
    now = deadline;
    throw new NativeTimeout("response");
  };
  const call = vi.fn<RpcClient["call"]>(async (method, params, deadline) => {
    const request = params as Record<string, unknown>;
    if (method === "thread/read") {
      return { thread };
    }
    if (method === "thread/turns/list") {
      if (request.threadId === slowChild) {
        timeOut(deadline!);
      }
      return { data: [newest] };
    }
    if (request.archived === true) {
      return { data: [] };
    }
    if (request.parentThreadId === slow || request.cursor === "next") {
      timeOut(deadline!);
    }
    if (request.parentThreadId === paged) {
      return {
        data: [{ ...thread, id: slowChild, parentThreadId: paged }],
        nextCursor: "next",
      };
    }
    return { data: [thread] };
  });
  try {
    const result = await collectAll(TEST_CLOCK, { call, close() {} }, now + 13_000, {
      decisionRecords: {},
      parents: [slow, paged, later],
      recipients: [],
      slot: 1,
    });
    expect(slices).toEqual([200, 200, 200]);
    expect(call.mock.calls.map(([method]) => method)).toEqual([
      ...Array<string>(7).fill("thread/list"),
      "thread/turns/list",
      "thread/turns/list",
      "thread/read",
      "thread/turns/list",
    ]);
    expect(result.collection_budget).toMatchObject({ calls_used: 11, max_calls: 256 });
    expect(result.worker_health[slow]).toMatchObject({
      diagnostics: ["native_timeout"],
      status: "partial",
    });
    expect(result.worker_health[paged]).toMatchObject({
      children: [
        { child_id: slowChild, diagnostics: ["native_timeout"], requires_parent_action: false },
      ],
      inventories: { active: { diagnostics: ["native_timeout"], pages: 1, status: "partial" } },
      status: "partial",
    });
    expect(result.worker_health[later]).toMatchObject({
      children: [
        {
          child_id: child,
          classification: "server_capacity",
          lineage_verified: true,
          requires_parent_action: true,
          turn_id: turn,
        },
      ],
      complete: true,
      status: "complete",
    });
  } finally {
    monotonic.mockRestore();
  }
});
