import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, main } from "../cli.ts";
import { gameLayout } from "../layout.ts";
import { readRegistry, updateRegistry } from "../registry/store.ts";
import { Store } from "./db.ts";
import { readInbox, sendMessage } from "./messages.ts";
import { releasePolicyHold, setPolicyHold } from "./policyHolds.ts";
import { openQuestion, setHold } from "./questions.ts";
import { claimReminder, listReminders, pendingReminders, settleReminder } from "./reminders.ts";
import { storeReminderCheck, storeReminderClaim, storeReminderSettle } from "./reminderService.ts";
import {
  ART,
  clearDecision,
  COORDINATOR,
  fakeCodex,
  GAME,
  storeFixture,
  TECH,
} from "./testStore.ts";
import type { WakeOutcome } from "./types.ts";
import { wakeRecipient } from "./wake.ts";

const ROLE = `${GAME}/art`;
const ACTOR = { nativeId: COORDINATOR, role: "game-coordinator" };
const RECIPIENT = { nativeId: ART, role: ROLE };
const ENV = { CLAUDE_CODE_SESSION_ID: COORDINATOR };
const ORIGINAL = "00000000-0000-4000-8000-000000000001";
const COALESCED = "00000000-0000-4000-8000-000000000002";

function setup(clear = true) {
  const fixture = storeFixture();
  if (clear) {
    clearDecision(fixture.layout, ART);
  }
  const store = Store.forLayout(fixture.layout);
  const scope = { layout: fixture.layout, registry: readRegistry(fixture.layout) };
  const context = { env: ENV, layout: fixture.layout };
  sendMessage(store, ACTOR, { body: "Original.", id: ORIGINAL, intent: "unblock", to: ROLE });
  return { ...fixture, context, scope, store };
}

function wake(
  store: Store,
  attempt: string,
  outcome: WakeOutcome = "failed",
  original = ORIGINAL,
  conversation = ART,
  reason = "transport-unavailable",
): void {
  store.transaction(() => {
    store.append({
      actor: ACTOR,
      key: `wake.claimed:${attempt}`,
      kind: "wake.claimed",
      payload: {
        conversation,
        count: 1,
        harness: "codex",
        messages: [original],
        role: ROLE,
        wake: attempt,
      },
    });
    store.append({
      actor: ACTOR,
      key: `wake.completed:${attempt}`,
      kind: "wake.completed",
      payload: { detail: reason, outcome, role: ROLE, wake: attempt },
    });
  });
}

describe("coordinator reminder ledger", () => {
  it("offers only confirmed unread evidence for the exact live recipient", () => {
    const { scope, store } = setup();
    try {
      expect(listReminders(store, scope)).toEqual([]);
      wake(store, "wrong-conversation", "failed", ORIGINAL, TECH);
      expect(listReminders(store, scope)).toEqual([]);
      wake(store, "refusal");
      sendMessage(store, ACTOR, { body: "Another.", id: COALESCED, intent: "queue", to: ROLE });
      store.append({
        actor: ACTOR,
        key: "wake.coalesced:later",
        kind: "wake.coalesced",
        payload: { messages: [COALESCED], role: ROLE, wake: "refusal" },
      });
      expect(listReminders(store, scope)).toMatchObject([
        { originals: [{ id: ORIGINAL, wake: { outcome: "failed", wake: "refusal" } }], role: ROLE },
      ]);
      expect(() =>
        claimReminder(store, scope, RECIPIENT, { originals: [ORIGINAL], role: ROLE }),
      ).toThrow("not-coordinator");
      openQuestion(store, RECIPIENT, { id: "q-art-pending", title: "Waiting for a decision" });
      expect(listReminders(store, scope)).toEqual([]);
      expect(() =>
        claimReminder(store, scope, ACTOR, { originals: [ORIGINAL], role: ROLE }),
      ).toThrow("reminder-role-guarded");
    } finally {
      store.close();
    }
  });

  it.each(["cli", "vscode"])(
    "qualifies a pinned idle %s root after compaction or a missing marker",
    async (source) => {
      const { context, scope, store } = setup(false);
      try {
        wake(store, "decision-clearance", "guarded", ORIGINAL, ART, "decision-clearance");
        expect(listReminders(store, scope)).toMatchObject([
          { originals: [{ id: ORIGINAL }], role: ROLE },
        ]);
        const { receipt } = await storeReminderClaim(
          context,
          {},
          { originals: [ORIGINAL], role: ROLE },
        );
        const codex = fakeCodex(ART, undefined, source);
        const normal = () => Promise.resolve(codex.client);
        const pinned = () => Promise.resolve({ ...codex.client, serverVersion: "0.171.0" });
        await expect(
          storeReminderCheck({ ...context, connectReminder: normal }, {}, receipt.id),
        ).rejects.toThrow("reminder-native-clearance-unverified");
        expect(
          await storeReminderCheck({ ...context, connectReminder: pinned }, {}, receipt.id),
        ).toMatchObject({ nativeIdle: true, receipt });

        clearDecision(scope.layout, ART);
        const withItem = (item: Record<string, unknown>) => () =>
          Promise.resolve({
            ...codex.client,
            serverVersion: "0.171.0",
            call: (method: string, params: unknown) =>
              method === "thread/items/list"
                ? Promise.resolve({ data: [{ item, turnId: "turn-1" }] })
                : codex.client.call(method, params),
          });
        expect(
          await storeReminderCheck(
            {
              ...context,
              connectReminder: withItem({ id: "item-compact", type: "contextCompaction" }),
            },
            {},
            receipt.id,
          ),
        ).toMatchObject({ nativeIdle: true, receipt });
        await expect(
          storeReminderCheck(
            {
              ...context,
              connectReminder: withItem({
                delivery: "async",
                id: "item-question",
                questions: [{ title: "Still waiting" }],
                type: "agentMessage",
              }),
            },
            {},
            receipt.id,
          ),
        ).rejects.toThrow("reminder-native-guarded");

        const marker = join(
          gameLayout(scope.layout, GAME).busDir,
          "unblock",
          "decisions",
          `${ART}.json`,
        );
        writeFileSync(marker, JSON.stringify({ state: "pending", thread_id: ART }));
        await expect(
          storeReminderCheck({ ...context, connectReminder: pinned }, {}, receipt.id),
        ).rejects.toThrow("reminder-owner-clearance-required");
        writeFileSync(marker, "{");
        await expect(
          storeReminderCheck({ ...context, connectReminder: pinned }, {}, receipt.id),
        ).rejects.toThrow("reminder-owner-clearance-required");
        expect(codex.adds()).toEqual([]);
      } finally {
        store.close();
      }
    },
  );

  it("retains a claim across reopen and rebuild and settles it idempotently", () => {
    const { scope, store } = setup();
    let id: string;
    try {
      wake(store, "definite-refusal");
      id = claimReminder(store, scope, ACTOR, { originals: [ORIGINAL], role: ROLE }).id;
    } finally {
      store.close();
    }
    const reopened = Store.forLayout(scope.layout);
    try {
      reopened.rebuild();
      expect(listReminders(reopened, scope)).toEqual([]);
      expect(pendingReminders(reopened)).toEqual([{ id, originals: [ORIGINAL], role: ROLE }]);
      sendMessage(reopened, ACTOR, {
        body: "Independent original.",
        id: COALESCED,
        intent: "queue",
        to: ROLE,
      });
      wake(reopened, "independent", "failed", COALESCED);
      expect(() =>
        claimReminder(reopened, scope, ACTOR, { originals: [COALESCED], role: ROLE }),
      ).toThrow("reminder-role-in-flight");
      expect(() =>
        claimReminder(reopened, scope, ACTOR, { originals: [ORIGINAL], role: ROLE }),
      ).toThrow("reminder-role-in-flight");
      const settlement = { id, outcome: "uncertain", reason: "pane-result-unknown" } as const;
      expect(settleReminder(reopened, scope, ACTOR, settlement)).toEqual(settlement);
      expect(settleReminder(reopened, scope, ACTOR, settlement)).toEqual(settlement);
      expect(() =>
        settleReminder(reopened, scope, ACTOR, { ...settlement, outcome: "submitted" }),
      ).toThrow("reminder-settlement-conflict");
      expect(pendingReminders(reopened)).toEqual([]);
      expect(listReminders(reopened, scope)).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("requires refusal, fresh exact evidence and a later review for reconsideration", () => {
    const { scope, store } = setup();
    try {
      wake(store, "first");
      const receipt = claimReminder(store, scope, ACTOR, { originals: [ORIGINAL], role: ROLE });
      settleReminder(store, scope, ACTOR, {
        id: receipt.id,
        outcome: "refused",
        reason: "pane-busy",
      });
      const review = (slot: number) =>
        store.append({
          actor: ACTOR,
          key: `review.brief:${slot}`,
          kind: "review.brief",
          payload: { game: GAME, messageId: `review-${slot}`, recipient: ACTOR.role, slot },
        });
      review(1);
      expect(listReminders(store, scope)).toEqual([]);
      wake(store, "fresh");
      expect(listReminders(store, scope)).toEqual([]);
      review(2);
      expect(listReminders(store, scope)).toMatchObject([
        { originals: [{ id: ORIGINAL }], role: ROLE },
      ]);
      const next = claimReminder(store, scope, ACTOR, { originals: [ORIGINAL], role: ROLE });
      settleReminder(store, scope, ACTOR, {
        id: next.id,
        outcome: "submitted",
        reason: "pane-submitted",
      });
      wake(store, "later-again");
      review(3);
      expect(listReminders(store, scope)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("blocks fallback while a native dispatch has reserved the same role and thread", async () => {
    const { scope, store } = setup();
    try {
      wake(store, "first-refused", "guarded", ORIGINAL, ART, "compaction-unproven");
      const codex = fakeCodex(ART);
      const entered = Promise.withResolvers<void>();
      const connecting = Promise.withResolvers<typeof codex.client>();
      const dispatch = wakeRecipient(
        {
          env: {},
          layout: scope.layout,
          ports: {
            connect: () => {
              entered.resolve();
              return connecting.promise;
            },
          },
          store,
        },
        ROLE,
      );
      await entered.promise;
      const secondStore = Store.forLayout(scope.layout);
      try {
        expect(listReminders(secondStore, scope)).toEqual([]);
        expect(() =>
          claimReminder(secondStore, scope, ACTOR, { originals: [ORIGINAL], role: ROLE }),
        ).toThrow("reminder-notice-outstanding");
      } finally {
        secondStore.close();
        connecting.resolve(codex.client);
        await dispatch;
      }
      expect(codex.adds()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("blocks native dispatch behind a claimed fallback and clears only on correlated history", async () => {
    const { context, scope, store } = setup();
    try {
      wake(store, "first");
      const { notice, receipt } = await storeReminderClaim(
        context,
        {},
        { originals: [ORIGINAL], role: ROLE },
      );
      expect(notice).toBe(`1 new messages for ${ROLE}: run coordination-kit inbox [${receipt.id}]`);
      readInbox(store, RECIPIENT);
      sendMessage(store, ACTOR, {
        body: "Later original.",
        id: COALESCED,
        intent: "queue",
        to: ROLE,
      });
      const codex = fakeCodex(ART);
      const call = codex.client.call.bind(codex.client);
      let text = `1 new messages for ${ROLE}: run coordination-kit inbox`;
      codex.client.call = (method, params) =>
        method === "thread/items/list" && !Object.hasOwn(params as object, "turnId")
          ? Promise.resolve({
              data: [
                {
                  item: {
                    content: [{ text, type: "text" }],
                    id: "fallback-item",
                    type: "userMessage",
                  },
                  turnId: "fallback-turn",
                },
              ],
            })
          : call(method, params);
      const attempt = () =>
        wakeRecipient(
          {
            env: {},
            layout: scope.layout,
            ports: { connect: () => Promise.resolve(codex.client) },
            store,
          },
          ROLE,
        );
      expect(await attempt()).toMatchObject({ status: "coalesced", wake: receipt.id });
      expect(codex.calls).toHaveLength(0);
      settleReminder(store, scope, ACTOR, {
        id: receipt.id,
        outcome: "submitted",
        reason: "pane-submitted",
      });
      expect(await attempt()).toMatchObject({ status: "coalesced", wake: receipt.id });
      expect(codex.adds()).toHaveLength(0);
      text = notice;
      expect(await attempt()).toMatchObject({ status: "accepted" });
      expect(codex.adds()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("checks an exact idle recipient and rejects changed binding, hold or recipient collection", async () => {
    const { context, scope, store } = setup();
    try {
      wake(store, "first");
      const { receipt } = await storeReminderClaim(
        context,
        {},
        { originals: [ORIGINAL], role: ROLE },
      );
      const codex = fakeCodex(ART);
      const probe = { ...context, connectReminder: () => Promise.resolve(codex.client) };
      expect(await storeReminderCheck(probe, {}, receipt.id)).toEqual({
        nativeIdle: true,
        receipt,
        schema: 1,
      });
      expect(codex.adds()).toEqual([]);
      const wrong = fakeCodex(TECH);
      await expect(
        storeReminderCheck(
          { ...context, connectReminder: () => Promise.resolve(wrong.client) },
          {},
          receipt.id,
        ),
      ).rejects.toThrow("reminder-native-guarded");
      setPolicyHold(store, ACTOR, {
        approval: "user-approval",
        id: "policy-art-hold",
        reason: "Paused",
        scope: `role:${ROLE}`,
      });
      await expect(storeReminderCheck(probe, {}, receipt.id)).rejects.toThrow(
        "reminder-role-guarded",
      );
      releasePolicyHold(store, ACTOR, { approval: "user-release", id: "policy-art-hold" });
      readInbox(store, RECIPIENT);
      await expect(storeReminderCheck(probe, {}, receipt.id)).rejects.toThrow(
        "reminder-original-stale",
      );
      updateRegistry(scope.layout, scope.registry.revision, (registry) => registry);
      await expect(storeReminderCheck(probe, {}, receipt.id)).rejects.toThrow(
        "reminder-binding-stale",
      );
      setHold(store, RECIPIENT, { id: "h-art-pause", reason: "Paused", scope: "role" });
      expect(listReminders(store, scope)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("wires list, exact claim and settlement through the coordinator CLI", async () => {
    const { base, context, root, store } = setup();
    try {
      wake(store, "confirmed");
    } finally {
      store.close();
    }
    const run = async (env: NodeJS.ProcessEnv, ...argv: string[]) => {
      let out = "";
      let err = "";
      const code = await main(
        { cwd: base, env, err: (part) => (err += part), out: (part) => (out += part) },
        ["--root", root, ...argv],
      );
      return { code, err, value: out === "" ? null : JSON.parse(out) };
    };
    const candidates = await run({}, "reminder", "list");
    expect(candidates).toMatchObject({
      code: EXIT_OK,
      value: { candidates: [{ role: ROLE }], schema: 1 },
    });
    const denied = await run(
      { CODEX_THREAD_ID: ART },
      "reminder",
      "claim",
      "--role",
      ROLE,
      "--original",
      ORIGINAL,
    );
    expect(denied).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: not-coordinator\n",
    });
    const claim = await run(ENV, "reminder", "claim", "--role", ROLE, "--original", ORIGINAL);
    expect(claim).toMatchObject({
      code: EXIT_OK,
      value: { receipt: { originals: [ORIGINAL], role: ROLE }, schema: 1 },
    });
    const id = (claim.value as { receipt: { id: string } }).receipt.id;
    expect(
      await run(
        ENV,
        "reminder",
        "settle",
        "--id",
        id,
        "--outcome",
        "submitted",
        "--reason",
        "pane-submitted",
      ),
    ).toMatchObject({ code: EXIT_OK, value: { settlement: { id, outcome: "submitted" } } });
    expect(
      await storeReminderSettle(
        context,
        {},
        { id, outcome: "submitted", reason: "pane-submitted" },
      ),
    ).toMatchObject({ settlement: { id } });
  });
});
