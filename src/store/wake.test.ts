import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readWakeFile, wakeFilePath } from "../adapters/claude/wakeFile.ts";
import { RpcError } from "../adapters/codex/rpc.ts";
import { updateRegistry } from "../registry/store.ts";
import { Store } from "./db.ts";
import { readInbox, sendMessage } from "./messages.ts";
import { ART, clearDecision, fakeCodex, GAMEPLAY, storeFixture, TECH } from "./testStore.ts";
import { pendingWakeRoles, rearmWake, type WakePorts, wakeRecipient, wakeState } from "./wake.ts";

const SENDER = { nativeId: "00000000-0000-4000-8000-0000000000c1", role: "game-coordinator" };
const TECH_ROLE = "archies-dog-walks/tech";
const ART_ROLE = "archies-dog-walks/art";
const SECRET_BODY = "Private body that must never reach a native transport.\n";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function setup(ports: WakePorts = {}) {
  const fixture = storeFixture();
  const store = Store.forLayout(fixture.layout);
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
  it("writes the wake file once per outstanding wake with no payload, and again after a pull", async () => {
    const { layout, send, store, wakes } = setup();
    expect(await send(TECH_ROLE)).toMatchObject({ status: "accepted" });
    const path = wakeFilePath(layout, TECH);
    expect(readWakeFile(path)).toEqual({ count: 1, role: TECH_ROLE, seq: 1 });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      count: 1,
      role: TECH_ROLE,
      schema: 1,
      seq: 1,
    });
    expect(readFileSync(path, "utf8")).not.toContain("Private body");
    expect(await send(TECH_ROLE)).toMatchObject({ status: "coalesced" });
    expect(readWakeFile(path)).toEqual({ count: 1, role: TECH_ROLE, seq: 1 });
    readInbox(store, { nativeId: TECH, role: TECH_ROLE });
    expect(wakeState(store, TECH_ROLE)).toEqual({ outstanding: null, pending: false });
    expect(await send(TECH_ROLE)).toMatchObject({ status: "accepted" });
    expect(readWakeFile(path)).toEqual({ count: 1, role: TECH_ROLE, seq: 2 });
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
    expect(existsSync(wakeFilePath(layout, GAMEPLAY))).toBe(false);
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
    updateRegistry(layout, 1, (draft) => {
      delete draft.roles["archies-dog-walks/gameplay"]!.phase;
    });
    expect(await send("archies-dog-walks/gameplay")).toMatchObject({ status: "accepted" });
    expect(readWakeFile(wakeFilePath(layout, GAMEPLAY))).toMatchObject({ count: 2, seq: 1 });
  });

  it("guards through the store question and hold seam", async () => {
    const { send } = setup({ storeGuard: () => ({ reason: "open-question", status: "blocked" }) });
    expect(await send(TECH_ROLE)).toMatchObject({ reason: "open-question", status: "guarded" });
  });
});

describe("Codex wakes", () => {
  it("adds one fixed-text queue entry through the guarded path and coalesces later sends", async () => {
    const codex = fakeCodex(ART);
    const { layout, send, store, wakes } = setup({ connect: () => Promise.resolve(codex.client) });
    clearDecision(layout, ART);
    expect(await send(ART_ROLE)).toMatchObject({ status: "accepted" });
    expect(codex.adds()).toEqual([
      {
        clientUserMessageId: expect.any(String),
        input: [
          {
            text: "1 new messages for archies-dog-walks/art: run coordination-kit inbox",
            text_elements: [],
            type: "text",
          },
        ],
        threadId: ART,
      },
    ]);
    expect(JSON.stringify(codex.calls)).not.toContain("Private body");
    expect(await send(ART_ROLE)).toMatchObject({ status: "coalesced" });
    expect(codex.adds()).toHaveLength(1);
    readInbox(store, { nativeId: ART, role: ART_ROLE });
    expect(await send(ART_ROLE)).toMatchObject({ status: "accepted" });
    expect(codex.adds()).toHaveLength(2);
    expect(wakes()).toEqual([
      { count: 1, detail: null, harness: "codex", outcome: "accepted", role: ART_ROLE },
      { count: 1, detail: null, harness: "codex", outcome: "accepted", role: ART_ROLE },
    ]);
  });

  it("logs an ambiguous wake without changing message state and never retries it before a pull", async () => {
    const codex = fakeCodex(ART, () => {
      throw new Error("connection dropped");
    });
    const { layout, send, store, wakes } = setup({ connect: () => Promise.resolve(codex.client) });
    clearDecision(layout, ART);
    expect(await send(ART_ROLE)).toMatchObject({ status: "ambiguous" });
    expect(store.db.prepare("SELECT state FROM messages").all()).toEqual([{ state: "sent" }]);
    expect(await send(ART_ROLE)).toMatchObject({ status: "coalesced" });
    expect(await send(ART_ROLE)).toMatchObject({ status: "coalesced" });
    expect(codex.adds()).toHaveLength(1);
    expect(wakes()).toEqual([
      {
        count: 1,
        detail: "transport-unavailable",
        harness: "codex",
        outcome: "ambiguous",
        role: ART_ROLE,
      },
    ]);
    expect(pendingWakeRoles(store)).toEqual([ART_ROLE]);
    // The review seam rearms an outstanding wake; the next wake then goes out once.
    expect(rearmWake(store, { nativeId: null, role: null }, ART_ROLE, "review slot")).toBe(true);
    expect(rearmWake(store, { nativeId: null, role: null }, ART_ROLE, "review slot")).toBe(false);
    expect(
      await wakeRecipient(
        { env: {}, layout, ports: { connect: () => Promise.resolve(codex.client) }, store },
        ART_ROLE,
      ),
    ).toMatchObject({
      status: "ambiguous",
    });
    expect(codex.adds()).toHaveLength(2);
    expect(
      store.db.prepare("SELECT count(*) AS n FROM messages WHERE state = 'sent'").get(),
    ).toEqual({ n: 3 });
  });

  it("logs a native refusal as failed and keeps it outstanding", async () => {
    const codex = fakeCodex(ART, () => {
      throw new RpcError({ code: -32600, message: "refused" }, "thread/queue/add");
    });
    const { layout, send, store } = setup({ connect: () => Promise.resolve(codex.client) });
    clearDecision(layout, ART);
    expect(await send(ART_ROLE)).toMatchObject({ status: "failed" });
    expect(wakeState(store, ART_ROLE).outstanding).not.toBeNull();
  });

  it("guards without connecting when the decision marker is missing, and retries on the next send", async () => {
    let connections = 0;
    const codex = fakeCodex(ART);
    const { layout, send, store } = setup({
      connect: () => {
        connections++;
        return Promise.resolve(codex.client);
      },
    });
    expect(await send(ART_ROLE)).toMatchObject({ status: "guarded" });
    expect(connections).toBe(0);
    expect(wakeState(store, ART_ROLE)).toEqual({ outstanding: null, pending: true });
    clearDecision(layout, ART);
    expect(await send(ART_ROLE)).toMatchObject({ status: "accepted" });
    expect(codex.adds()[0]?.input).toEqual([
      {
        text: "2 new messages for archies-dog-walks/art: run coordination-kit inbox",
        text_elements: [],
        type: "text",
      },
    ]);
  });

  it("guards on a pending native question", async () => {
    const codex = fakeCodex(ART);
    const call = codex.client.call.bind(codex.client);
    codex.client.call = (method, params) =>
      method === "thread/items/list"
        ? Promise.resolve({
            data: [
              {
                item: {
                  id: "question-1",
                  questions: [{ id: "q", question: "Proceed?" }],
                  type: "agentMessage",
                },
                turnId: "turn-1",
              },
            ],
          })
        : call(method, params);
    const { layout, send } = setup({ connect: () => Promise.resolve(codex.client) });
    clearDecision(layout, ART);
    expect(await send(ART_ROLE)).toMatchObject({ status: "guarded" });
    expect(codex.adds()).toEqual([]);
  });
});
