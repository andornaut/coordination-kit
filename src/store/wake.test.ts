import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { wakeFilePath } from "../adapters/claude/wakeFile.ts";
import { NativeTimeout, RpcError } from "../adapters/codex/rpc.ts";
import { TEST_CLOCK, TEST_CONTEXT } from "../core/testFixtures.ts";
import { updateRegistry } from "../registry/store.ts";
import { Store } from "./db.ts";
import { readInbox, sendMessage } from "./messages.ts";
import { messageWake } from "./messageWake.ts";
import { setPolicyHold } from "./policyHolds.ts";
import { openQuestion } from "./questions.ts";
import { ART, fakeCodex, storeFixture, TECH } from "./testStore.ts";
import { rearmWake, type WakePorts, wakeRecipient, wakeState } from "./wake.ts";

const SENDER = { nativeId: "00000000-0000-4000-8000-0000000000c1", role: "game-coordinator" };
const TECH_ROLE = "archies-dog-walks/tech";
const ART_ROLE = "archies-dog-walks/art";
const SECRET_BODY = "Private body that must never reach a native transport.\n";

/** The wake file's parsed contents. */
function onDisk(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function setup(ports: WakePorts = {}) {
  const fixture = storeFixture();
  const store = Store.forLayout(TEST_CONTEXT, fixture.layout);
  let n = 0;
  const send = async (to: string) => {
    n++;
    sendMessage(store, SENDER, { body: SECRET_BODY, id: uuid(n), intent: "queue", to });
    return wakeRecipient({ env: {}, layout: fixture.layout, ports, store }, to);
  };
  const wakes = () =>
    store.db.prepare("SELECT role, harness, count, outcome, detail FROM wakes ORDER BY seq").all();
  return { ...fixture, send, store, wakes };
}

describe("Claude wakes", () => {
  it("keeps an independent wake that replaced the review plan's outstanding wake", async () => {
    const { send, store } = setup();
    await send(TECH_ROLE);
    const attempt = { key: "wake.rearmed:review:fixture", ...wakeState(store, TECH_ROLE) };
    readInbox(store, { nativeId: TECH, role: TECH_ROLE });
    const replacement = await send(TECH_ROLE);

    expect(rearmWake(store, SENDER, TECH_ROLE, "review", attempt)).toBe(false);
    expect(wakeState(store, TECH_ROLE).outstanding).toBe(replacement.wake);
  });

  it("writes the wake file once per outstanding wake with no payload, and again after a pull", async () => {
    const { layout, send, store, wakes } = setup();
    expect(await send(TECH_ROLE)).toMatchObject({ status: "accepted" });
    const path = wakeFilePath(layout, TECH_ROLE);
    expect(onDisk(path)).toEqual({ count: 1, role: TECH_ROLE, schema: 1, seq: 1 });
    expect(readFileSync(path, "utf8")).not.toContain("Private body");
    expect(await send(TECH_ROLE)).toMatchObject({ status: "coalesced" });
    expect(onDisk(path)).toEqual({ count: 1, role: TECH_ROLE, schema: 1, seq: 1 });
    readInbox(store, { nativeId: TECH, role: TECH_ROLE });
    expect(wakeState(store, TECH_ROLE)).toEqual({ outstanding: null, pending: false });
    expect(await send(TECH_ROLE)).toMatchObject({ status: "accepted" });
    expect(onDisk(path)).toEqual({ count: 1, role: TECH_ROLE, schema: 1, seq: 2 });
    expect(wakes()).toEqual([
      { count: 1, detail: null, harness: "claude", outcome: "accepted", role: TECH_ROLE },
      { count: 1, detail: null, harness: "claude", outcome: "accepted", role: TECH_ROLE },
    ]);
  });

  it("guards a held recipient on the registry flag, logs it and wakes once released", async () => {
    const { layout, send, store, wakes } = setup();
    expect(await send("archies-dog-walks/gameplay")).toMatchObject({
      reason: "recipient-held",
      status: "guarded",
    });
    expect(existsSync(wakeFilePath(layout, "archies-dog-walks/gameplay"))).toBe(false);
    expect(wakeState(store, "archies-dog-walks/gameplay").outstanding).toBeNull();
    expect(wakes()).toEqual([
      {
        count: 1,
        detail: "recipient-held",
        harness: "claude",
        outcome: "guarded",
        role: "archies-dog-walks/gameplay",
      },
    ]);
    updateRegistry(TEST_CLOCK, layout, 1, (draft) => {
      delete draft.roles["archies-dog-walks/gameplay"]!.phase;
    });
    expect(await send("archies-dog-walks/gameplay")).toMatchObject({ status: "accepted" });
    expect(onDisk(wakeFilePath(layout, "archies-dog-walks/gameplay"))).toMatchObject({
      count: 2,
      seq: 1,
    });
  });

  it("keeps the role's wake file across a rebind and wakes the new binding", async () => {
    const { layout, send, store, wakes } = setup();
    const path = wakeFilePath(layout, TECH_ROLE);
    expect(await send(TECH_ROLE)).toMatchObject({ status: "accepted" });
    const rotated = "00000000-0000-4000-8000-0000000000e2";
    updateRegistry(TEST_CLOCK, layout, 1, (draft) => {
      draft.roles[TECH_ROLE]!.conversations.claude = rotated;
    });
    // The outstanding wake belongs to the earlier binding, so the next send wakes the new one.
    expect(await send(TECH_ROLE)).toMatchObject({ status: "accepted" });
    expect(onDisk(path)).toEqual({ count: 2, role: TECH_ROLE, schema: 1, seq: 2 });
    expect(await send(TECH_ROLE)).toMatchObject({ status: "coalesced" });
    expect(onDisk(path)).toEqual({ count: 2, role: TECH_ROLE, schema: 1, seq: 2 });
    expect(
      store.db
        .prepare("SELECT conversation FROM wakes WHERE outcome = 'accepted' ORDER BY seq")
        .all(),
    ).toEqual([{ conversation: TECH }, { conversation: rotated }]);
    expect(wakes()).toHaveLength(2);
  });

  it("guards through the store question and hold seam", async () => {
    const { send } = setup({ storeGuard: () => ({ reason: "open-question", status: "blocked" }) });
    expect(await send(TECH_ROLE)).toMatchObject({ reason: "open-question", status: "guarded" });
  });
});

describe("Codex wakes", () => {
  it("queues one wake with no payload and needs no decision marker", async () => {
    const codex = fakeCodex(ART);
    const { send, store } = setup({ connect: () => Promise.resolve(codex.client) });
    expect(await send(ART_ROLE)).toMatchObject({ status: "accepted" });
    expect(await send(ART_ROLE)).toMatchObject({ status: "coalesced" });
    expect(codex.adds()).toHaveLength(1);
    expect(codex.adds()[0]?.input).toEqual([
      {
        text: "1 new messages for archies-dog-walks/art: run coordination-kit inbox",
        text_elements: [],
        type: "text",
      },
    ]);
    expect(JSON.stringify(codex.calls)).not.toContain("Private body");
    expect(codex.calls.map(({ method }) => method)).not.toContain("thread/items/list");
    expect(wakeState(store, ART_ROLE).outstanding).not.toBeNull();
  });

  it.each([
    ["incomplete", () => ({ data: [], truncated: true })],
    ["incomplete", () => ({ data: [{ input: [] }] })],
    ["pagination-unverified", () => ({ data: [], nextCursor: "same-page" })],
    [
      "timeout",
      () => {
        throw new NativeTimeout(SECRET_BODY);
      },
    ],
    [
      "refused",
      () => {
        throw new RpcError({ code: -32601, message: SECRET_BODY }, "thread/queue/list");
      },
    ],
    [
      "unverified",
      () => {
        throw new Error(SECRET_BODY);
      },
    ],
  ] as const)("keeps a wake guarded when queue inventory is %s", async (reason, page) => {
    const codex = fakeCodex(ART);
    const call = codex.client.call.bind(codex.client);
    codex.client.call = async (method, params) =>
      method === "thread/queue/list" ? page() : call(method, params);
    const { send, store } = setup({ connect: () => Promise.resolve(codex.client) });
    expect(await send(ART_ROLE)).toMatchObject({ status: "guarded" });
    const evidence = messageWake(store, uuid(1), ART_ROLE, "sent");
    expect(evidence).toMatchObject({
      nextAction: "collect-at-safe-boundary",
      outcome: "guarded",
      reason: `native-notice-queue-${reason}`,
    });
    expect(JSON.stringify(evidence)).not.toContain(SECRET_BODY.trim());
    expect(codex.adds()).toHaveLength(0);
    expect(store.db.prepare("SELECT state FROM messages").all()).toEqual([{ state: "sent" }]);
  });

  it.each([0, 1])("recognizes a queued wake after %i clear queue reads", async (clearReads) => {
    const codex = fakeCodex(ART);
    const entry = {
      clientUserMessageId: "earlier",
      id: "queue-earlier",
      input: [
        {
          text: "1 new messages for archies-dog-walks/art: run coordination-kit inbox",
          type: "text",
        },
      ],
    };
    const call = codex.client.call.bind(codex.client);
    let reads = 0;
    codex.client.call = (method, params) =>
      method === "thread/queue/list"
        ? Promise.resolve({ data: reads++ < clearReads ? [] : [entry] })
        : call(method, params);
    const { send, store } = setup({ connect: () => Promise.resolve(codex.client) });
    expect(await send(ART_ROLE)).toMatchObject({ status: "guarded" });
    expect(messageWake(store, uuid(1), ART_ROLE, "sent")).toMatchObject({
      nextAction: "collect-at-safe-boundary",
      outcome: "guarded",
      reason: "native-notice-already-queued",
    });
    expect(codex.adds()).toHaveLength(0);
  });

  it("logs a native refusal as failed and keeps it outstanding until the review rearms it", async () => {
    const codex = fakeCodex(ART, () => {
      throw new RpcError({ code: -32600, message: "refused" }, "thread/queue/add");
    });
    const { send, store } = setup({ connect: () => Promise.resolve(codex.client) });
    expect(await send(ART_ROLE)).toMatchObject({ status: "failed" });
    expect(wakeState(store, ART_ROLE).outstanding).not.toBeNull();
    expect(rearmWake(store, SENDER, ART_ROLE, "review")).toBe(true);
    expect(wakeState(store, ART_ROLE)).toEqual({ outstanding: null, pending: true });
  });

  it("guards without connecting while the recipient has a pending store question", async () => {
    let connections = 0;
    const codex = fakeCodex(ART);
    const { send, store } = setup({
      connect: () => {
        connections++;
        return Promise.resolve(codex.client);
      },
    });
    openQuestion(store, { nativeId: ART, role: ART_ROLE }, { id: "q-art-1", title: "Proceed?" });
    expect(await send(ART_ROLE)).toMatchObject({
      reason: "recipient-question-pending",
      status: "guarded",
    });
    expect(connections).toBe(0);
  });

  it("rechecks an exact policy hold set while a Codex wake is connecting", async () => {
    const codex = fakeCodex(ART);
    const { layout, send, store } = setup({
      connect: () => {
        const writer = Store.forLayout(TEST_CONTEXT, layout);
        setPolicyHold(writer, SENDER, {
          approval: "request-1",
          id: "policy-art",
          reason: "User paused.",
          scope: `role:${ART_ROLE}`,
        });
        writer.close();
        return Promise.resolve(codex.client);
      },
    });
    expect(await send(ART_ROLE)).toMatchObject({ status: "guarded" });
    expect(codex.adds()).toEqual([]);
    expect(wakeState(store, ART_ROLE)).toEqual({ outstanding: null, pending: true });
    expect(await send(ART_ROLE)).toMatchObject({
      reason: "recipient-policy-hold-active",
      status: "guarded",
    });
  });

  it("guards while the thread waits on a native question or approval", async () => {
    const codex = fakeCodex(ART);
    const call = codex.client.call.bind(codex.client);
    codex.client.call = (method, params) =>
      method === "thread/read"
        ? Promise.resolve({
            thread: {
              canAcceptDirectInput: true,
              id: ART,
              parentThreadId: null,
              source: "cli",
              status: { activeFlags: ["waitingOnUserInput"], type: "active" },
            },
          })
        : call(method, params);
    const { send, store } = setup({ connect: () => Promise.resolve(codex.client) });
    expect(await send(ART_ROLE)).toMatchObject({ status: "guarded" });
    expect(codex.adds()).toEqual([]);
    expect(store.db.prepare("SELECT detail FROM wakes").get()).toEqual({
      detail: "state-unavailable",
    });
  });
});
