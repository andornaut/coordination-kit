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
      deadline - 5000,
    ],
    [
      "thread/list",
      expect.objectContaining({ archived: true, parentThreadId: parent }),
      deadline - 5000,
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
  expect(call.mock.calls.map(([method, , limit]) => [method, limit])).toEqual([
    ["thread/items/list", deadline - 13_000],
    ["thread/list", deadline - 5000],
    ["thread/list", deadline - 5000],
  ]);
});
