import { describe, expect, it } from "vitest";

import { Store } from "./db.ts";
import { sendMessage } from "./messages.ts";
import { messageWake, safeWakeBlocker } from "./messageWake.ts";
import { storeDone, storeInbox, storeInboxPeek, storeSend, storeStatus } from "./service.ts";
import { ART, COORDINATOR, fakeCodex, storeFixture, TECH } from "./testStore.ts";

const ART_ROLE = "archies-dog-walks/art";
const TECH_ROLE = "archies-dog-walks/tech";
const FIRST = "00000000-0000-4000-8000-000000000101";
const SECOND = "00000000-0000-4000-8000-000000000102";
const INDEPENDENT = "00000000-0000-4000-8000-000000000103";

describe("per-original wake status", () => {
  it("binds question references to the recipient and policy holds to their issuer", () => {
    const ref = { itemId: "item-17", turnId: "turn-17" };
    const question = { id: "q-art-17", kind: "question", native: ref, owner: ART_ROLE };
    const policy = { id: "policy-art-pause", kind: "policy-hold", owner: "game-coordinator" };
    expect(safeWakeBlocker(question, ART_ROLE)).toEqual(question);
    expect(safeWakeBlocker(question, TECH_ROLE)).toBeNull();
    expect(safeWakeBlocker(policy, ART_ROLE)).toEqual(policy);
    expect(safeWakeBlocker({ ...policy, owner: ART_ROLE }, ART_ROLE)).toBeNull();
  });

  it("keeps a guarded original visible to its recipient and never retries an identical send", async () => {
    const { layout } = storeFixture();
    const codex = fakeCodex(ART);
    let pending = true;
    const sender = {
      env: { CLAUDE_CODE_SESSION_ID: COORDINATOR },
      layout,
      ports: {
        connect: () => Promise.resolve(codex.client),
        storeGuard: () =>
          pending
            ? {
                blocker: { id: "q-art-17", kind: "question" as const, owner: ART_ROLE },
                reason: "recipient-question-pending",
                status: "blocked" as const,
              }
            : { status: "clear" as const },
      },
    };
    const recipient = { env: { CODEX_THREAD_ID: ART }, layout };
    const request = { body: "Original remains in the store.", id: FIRST, to: ART_ROLE };
    const result = await storeSend(sender, {}, request);
    expect(result.wake).toMatchObject({
      evidence: {
        blocker: { id: "q-art-17", kind: "question", owner: ART_ROLE },
        nextAction: "collect-at-safe-boundary",
        outcome: "guarded",
        reason: "recipient-question-pending",
      },
      status: "guarded",
    });

    pending = false;
    const repeated = await storeSend(sender, {}, request);
    expect(repeated.duplicate).toBe(true);
    expect(repeated.wake).toEqual(result.wake);
    expect(codex.adds()).toHaveLength(0);

    await storeSend(sender, {}, { body: "Unrelated recipient.", id: INDEPENDENT, to: TECH_ROLE });
    const passive = await storeInboxPeek(recipient, {});
    expect(passive).toMatchObject({
      count: 1,
      role: ART_ROLE,
      unread: [{ id: FIRST, to: ART_ROLE, wake: result.wake.evidence }],
    });
    expect(passive.unread[0]).not.toHaveProperty("body");
    expect((await storeStatus(sender, FIRST)).message).toMatchObject({
      deliveredAt: null,
      state: "sent",
    });
    expect(await storeInboxPeek(recipient, {})).toEqual(passive);

    const collected = await storeInbox(recipient, {}, { includeBody: true });
    expect(collected).toMatchObject({
      delivered: 1,
      messages: [{ body: request.body, id: FIRST, state: "delivered" }],
    });
    expect((await storeInbox(recipient, {}, {})).delivered).toBe(0);
    expect((await storeInboxPeek(recipient, {})).count).toBe(0);
    expect((await storeStatus(sender, FIRST)).wake).toMatchObject({
      nextAction: "reconcile-original",
      outcome: "guarded",
      wake: result.wake.evidence.wake,
    });
    await storeDone(recipient, {}, FIRST, {});
    expect(await storeStatus(sender, FIRST)).toMatchObject({
      message: { state: "handled" },
      wake: { nextAction: "none" },
    });
    expect((await storeStatus(sender, INDEPENDENT)).message.state).toBe("sent");
  });

  it("keeps an ambiguous attempt and separate coalesced original visible across projection replay", async () => {
    const { layout } = storeFixture();
    const codex = fakeCodex(ART, () => {
      throw new Error("Connection dropped.");
    });
    const sender = {
      env: { CLAUDE_CODE_SESSION_ID: COORDINATOR },
      layout,
      ports: { connect: () => Promise.resolve(codex.client) },
    };
    const request = { body: "Original.", id: FIRST, to: ART_ROLE };
    const ambiguous = await storeSend(sender, {}, request);
    const coalesced = await storeSend(sender, {}, { ...request, id: SECOND });
    expect(ambiguous.wake.evidence).toMatchObject({
      nextAction: "reconcile-without-resending",
      outcome: "ambiguous",
    });
    expect(coalesced.wake.evidence).toMatchObject({
      blocker: { id: ambiguous.wake.evidence.wake, kind: "wake", owner: ART_ROLE },
      nextAction: "reconcile-without-resending",
      outcome: "coalesced",
    });
    for (const id of [FIRST, SECOND]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await storeSend(sender, {}, { ...request, id })).duplicate).toBe(true);
    }
    expect(codex.adds()).toHaveLength(1);
    const store = Store.forLayout(layout);
    try {
      store.rebuild();
    } finally {
      store.close();
    }
    expect((await storeStatus(sender, FIRST)).wake).toEqual(ambiguous.wake.evidence);
    expect((await storeStatus(sender, SECOND)).wake).toEqual(coalesced.wake.evidence);
  });

  it("does not guess a wake for a legacy message without exact associations", () => {
    const store = Store.open(":memory:");
    try {
      const actor = { nativeId: COORDINATOR, role: "game-coordinator" };
      sendMessage(store, actor, { body: "Legacy body.", id: FIRST, intent: "queue", to: ART_ROLE });
      store.append({
        actor,
        key: "wake.claimed:legacy",
        kind: "wake.claimed",
        payload: { conversation: ART, count: 1, harness: "codex", role: ART_ROLE, wake: SECOND },
      });
      expect(messageWake(store, FIRST, ART_ROLE, "sent")).toEqual({
        blocker: null,
        nextAction: "collect-at-safe-boundary",
        outcome: "unknown",
        reason: "exact-wake-evidence-unavailable",
        wake: null,
      });
    } finally {
      store.close();
    }
  });

  it("preserves Claude acceptance and does not apply it to later originals", async () => {
    const { layout } = storeFixture();
    const sender = { env: { CLAUDE_CODE_SESSION_ID: COORDINATOR }, layout };
    const recipient = { env: { CLAUDE_CODE_SESSION_ID: TECH }, layout };
    await storeSend(sender, {}, { body: "First.", id: FIRST, to: TECH_ROLE });
    await storeSend(sender, {}, { body: "Second.", id: SECOND, to: TECH_ROLE });
    const status = await storeInboxPeek(recipient, {});
    expect(status.unread).toMatchObject([
      { id: FIRST, wake: { outcome: "accepted" } },
      { id: SECOND, wake: { outcome: "coalesced" } },
    ]);
    expect((await storeInbox(recipient, {}, {})).delivered).toBe(2);
  });
});
