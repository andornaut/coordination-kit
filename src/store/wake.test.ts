import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readWakeFile, wakeFilePath } from "../adapters/claude/wakeFile.ts";
import { RpcError } from "../adapters/codex/rpc.ts";
import { writeJsonDurable } from "../durable.ts";
import { updateRegistry } from "../registry/store.ts";
import { Store, storeRoot } from "./db.ts";
import { readInbox, sendMessage } from "./messages.ts";
import { noticeText } from "./noticesInFlight.ts";
import { setPolicyHold } from "./policyHolds.ts";
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
  it("requires exact native consumption when a pull lacks owner evidence", async () => {
    const codex = fakeCodex(ART);
    let queued: Record<string, unknown>[] = [];
    let history: Record<string, unknown>[] = [];
    const call = codex.client.call.bind(codex.client);
    codex.client.call = (method, params) => {
      if (method === "thread/queue/list") {
        return Promise.resolve({ data: queued });
      }
      if (method === "thread/items/list" && !Object.hasOwn(params as object, "turnId")) {
        return Promise.resolve({ data: history });
      }
      return call(method, params);
    };
    const { layout, send, store, wakes } = setup({ connect: () => Promise.resolve(codex.client) });
    clearDecision(layout, ART);
    const first = await send(ART_ROLE);
    expect(first).toMatchObject({ status: "accepted" });
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
    const input = codex.adds()[0]?.input;
    queued = [{ clientUserMessageId: first.wake, id: `queue-${first.wake}`, input }];
    expect(JSON.stringify(codex.calls)).not.toContain("Private body");
    readInbox(store, { nativeId: TECH, role: ART_ROLE });
    store.rebuild();
    expect(await send(ART_ROLE)).toMatchObject({ status: "coalesced", wake: first.wake });

    const item = { clientId: first.wake, content: input, id: "consumed-item", type: "userMessage" };
    history = [{ item, turnId: "consumed-turn" }];
    expect(await send(ART_ROLE)).toMatchObject({ status: "coalesced", wake: first.wake });

    queued = [];
    item.clientId = uuid(100);
    expect(await send(ART_ROLE)).toMatchObject({ status: "coalesced", wake: first.wake });

    item.clientId = first.wake;
    expect(await send(ART_ROLE)).toMatchObject({ status: "accepted" });
    expect(codex.adds()).toHaveLength(2);
    expect(
      store.db.prepare("SELECT kind FROM events WHERE kind = 'notice.consumed'").all(),
    ).toEqual([{ kind: "notice.consumed" }]);
    expect(wakes()).toEqual([
      { count: 1, detail: null, harness: "codex", outcome: "accepted", role: ART_ROLE },
      { count: 4, detail: null, harness: "codex", outcome: "accepted", role: ART_ROLE },
    ]);
  });

  it("releases an accepted modern claim after the exact owner collects every original", async () => {
    const codex = fakeCodex(ART);
    const ports = { connect: () => Promise.resolve(codex.client) };
    const { layout, send, store } = setup(ports);
    clearDecision(layout, ART);
    const owner = { nativeId: ART, role: ART_ROLE };
    for (const id of [uuid(101), uuid(102)]) {
      sendMessage(store, SENDER, { body: "Original.", id, intent: "queue", to: ART_ROLE });
    }
    const first = await wakeRecipient({ env: {}, layout, ports, store }, ART_ROLE);
    const firstPull = store.append({
      actor: owner,
      key: "inbox.read:partial",
      kind: "inbox.read",
      payload: { delivered: [uuid(101)], role: ART_ROLE },
    }).event.seq;
    expect(await send(ART_ROLE)).toMatchObject({ status: "coalesced" });
    expect(codex.adds()).toHaveLength(1);
    expect(readInbox(store, owner).delivered).toBe(2);
    const secondPull = store.events({ kinds: ["inbox.read"] }).at(-1)!.seq;

    const firstLaterCall = codex.calls.length;
    expect(await send(ART_ROLE)).toMatchObject({ status: "accepted" });
    expect(codex.adds()).toHaveLength(2);
    const events = store.events({ kinds: ["notice.consumed", "notice.released"] });
    expect(events).toMatchObject([
      {
        kind: "notice.released",
        payload: {
          conversation: ART,
          id: first.wake,
          inboxReads: [firstPull, secondPull],
          queueId: `queue-${first.wake}`,
          reason: "accepted-queue-absent-originals-collected",
          role: ART_ROLE,
        },
      },
    ]);
    expect(
      codex.calls
        .slice(firstLaterCall)
        .filter(
          ({ method, params }) =>
            method === "thread/items/list" && !Object.hasOwn(params, "turnId"),
        ),
    ).toHaveLength(0);
    store.rebuild();
    expect(
      store.db.prepare("SELECT id FROM pending_notices WHERE id = ?").get(first.wake!),
    ).toBeUndefined();
  });

  it.each([
    { name: "exact count and owner", releases: true },
    { name: "labelled exact owner", releases: true, worker: "label" },
    { name: "mismatched count", count: 2 },
    { name: "labelled different native actor", actor: TECH, worker: "label" },
    { name: "nonempty native queue", queued: true },
    { name: "incomplete queue inventory", truncated: true },
    { name: "pending native question", question: true },
  ])(
    "legacy collection with $name",
    async ({ actor, count = 1, question, queued, releases, truncated, worker }) => {
      const codex = fakeCodex(ART);
      const call = codex.client.call.bind(codex.client);
      const old = uuid(100);
      const input = [{ text: noticeText(count, ART_ROLE), type: "text" }];
      codex.client.call = (method, params) => {
        if (method === "thread/queue/list" && (queued || truncated)) {
          return Promise.resolve({
            data: queued ? [{ clientUserMessageId: old, id: `queue-${old}`, input }] : [],
            truncated,
          });
        }
        if (
          method === "thread/items/list" &&
          question &&
          Object.hasOwn(params as object, "turnId")
        ) {
          return Promise.resolve({
            data: [
              {
                item: {
                  id: "item-question",
                  questions: [{ title: "Waiting for a decision" }],
                  type: "agentMessage",
                },
                turnId: "turn-1",
              },
            ],
          });
        }
        return call(method, params);
      };
      const { layout, send, store } = setup({ connect: () => Promise.resolve(codex.client) });
      clearDecision(layout, ART);
      sendMessage(store, SENDER, {
        body: "Original.",
        id: uuid(101),
        intent: "queue",
        to: ART_ROLE,
      });
      store.append({
        actor: SENDER,
        key: `wake.claimed:${old}`,
        kind: "wake.claimed",
        payload: { conversation: ART, count, harness: "codex", role: ART_ROLE, wake: old },
      });
      store.append({
        actor: SENDER,
        key: `wake.completed:${old}`,
        kind: "wake.completed",
        payload: { outcome: "accepted", role: ART_ROLE, wake: old },
      });
      const receiptDirectory = join(storeRoot(layout), "wake", "codex");
      mkdirSync(receiptDirectory, { recursive: true });
      writeJsonDurable(join(receiptDirectory, `${old}.json`), {
        clientUserMessageId: old,
        queueId: `queue-${old}`,
        recipient: ART,
        status: "accepted",
        text: noticeText(count, ART_ROLE),
      });

      sendMessage(store, SENDER, { body: "Later.", id: uuid(102), intent: "queue", to: ART_ROLE });
      expect(
        readInbox(store, {
          nativeId: actor ?? ART,
          role: ART_ROLE,
          ...(worker === undefined ? {} : { worker }),
        }).delivered,
      ).toBe(2);
      expect(await send(ART_ROLE)).toMatchObject({ status: releases ? "accepted" : "coalesced" });
      expect(codex.adds()).toHaveLength(releases ? 1 : 0);
      expect(
        store.events({ kinds: ["notice.consumed", "notice.released"] }).map(({ kind }) => kind),
      ).toEqual(releases ? ["notice.released"] : []);
    },
  );

  it("keeps an ambiguous wake reserved across inbox pulls and review without native proof", async () => {
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
    // The review seam preserves unresolved Codex acceptance even at the next slot.
    expect(rearmWake(store, { nativeId: null, role: null }, ART_ROLE, "review slot")).toBe(false);
    expect(
      await wakeRecipient(
        { env: {}, layout, ports: { connect: () => Promise.resolve(codex.client) }, store },
        ART_ROLE,
      ),
    ).toMatchObject({
      status: "coalesced",
    });
    readInbox(store, { nativeId: ART, role: ART_ROLE });
    expect(await send(ART_ROLE)).toMatchObject({ status: "coalesced" });
    expect(codex.adds()).toHaveLength(1);
    expect(
      store.db.prepare("SELECT count(*) AS n FROM messages WHERE state = 'sent'").get(),
    ).toEqual({ n: 1 });
  });

  it("withholds a native wake when queue inventory cannot be verified", async () => {
    const codex = fakeCodex(ART);
    const call = codex.client.call.bind(codex.client);
    codex.client.call = (method, params) =>
      method === "thread/queue/list"
        ? Promise.resolve({ data: [], truncated: true })
        : call(method, params);
    const { layout, send, store } = setup({ connect: () => Promise.resolve(codex.client) });
    clearDecision(layout, ART);
    expect(await send(ART_ROLE)).toMatchObject({ status: "guarded" });
    expect(store.db.prepare("SELECT detail FROM wakes").get()).toEqual({
      detail: "native-notice-queue-unverified",
    });
    expect(codex.adds()).toHaveLength(0);
    expect(store.db.prepare("SELECT state FROM messages").all()).toEqual([{ state: "sent" }]);
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

  it("rechecks an exact policy hold set while a Codex wake is connecting", async () => {
    const codex = fakeCodex(ART);
    const { layout, send, store } = setup({
      connect: () => {
        const writer = Store.forLayout(layout);
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
    clearDecision(layout, ART);
    expect(await send(ART_ROLE)).toMatchObject({ status: "guarded" });
    expect(codex.adds()).toEqual([]);
    expect(wakeState(store, ART_ROLE)).toEqual({ outstanding: null, pending: true });
    expect(await send(ART_ROLE)).toMatchObject({
      reason: "recipient-policy-hold-active",
      status: "guarded",
    });
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
