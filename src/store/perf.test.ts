// Exercise exact lookups in a large disposable index, then measure sends, reads and closes that
// reopen a small durable journal. The durable scenario includes replay on each operation.
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { TEST_CLOCK, TEST_CONTEXT } from "../core/testFixtures.ts";
import { MEMORY, Store } from "./db.ts";
import {
  closeMessage,
  messageStatus,
  recipientMessages,
  sendMessage,
} from "./messages/messages.ts";
import { storeDone, storeInbox, storeSend } from "./messages/service.ts";
import { COORDINATOR, storeFixture, TECH } from "./testStore.ts";

const VOLUME = 30_000;
const DURABLE_VOLUME = 240;
const SAMPLES = 12;
const ROLES = Array.from({ length: 24 }, (_, index) => `archies-dog-walks/role-${index}`);

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1]! * 10) / 10;
}

function seed(store: Store, volume: number): void {
  const sender = { nativeId: COORDINATOR, role: "game-coordinator" };
  for (let start = 0; start < volume; start += 1000) {
    store.transaction(() => {
      for (let n = start; n < Math.min(volume, start + 1000); n++) {
        const role = ROLES[n % ROLES.length]!;
        sendMessage(store, sender, {
          body: `Synthetic message ${n}.\n`,
          id: uuid(n + 1),
          intent: "queue",
          to: role,
        });
        // About one in fifty stays open, as in the live inboxes.
        if (n % 50 !== 0) {
          closeMessage(store, { nativeId: null, role }, uuid(n + 1), { work: "ck-0017" });
        }
      }
    });
  }
}

describe("store performance", () => {
  it("finds exact messages, open recipient entries and event keys among 30,000 messages", () => {
    const store = Store.open(TEST_CLOCK, MEMORY);
    try {
      seed(store, VOLUME);
      expect(store.index.rows("messages")).toHaveLength(VOLUME);
      expect(messageStatus(store, uuid(VOLUME))).toMatchObject({
        id: uuid(VOLUME),
        state: "handled",
      });
      const open = recipientMessages(store, ROLES[0]!, ["sent", "delivered", "retained"]);
      expect(open.map(({ id }) => id)).toEqual(
        Array.from({ length: VOLUME / 600 }, (_, index) => uuid(index * 600 + 1)),
      );
      expect(store.eventByKey(`msg.sent:${uuid(1)}`)).toEqual(store.eventAt(1));
      expect(store.eventAt(store.head().seq)?.hash).toBe(store.head().hash);
    } finally {
      store.close();
    }
  });

  it(
    "reopens the journal across send, inbox and done without duplicating events",
    { timeout: 60_000 },
    async () => {
      const { layout } = storeFixture();
      const store = Store.forLayout(TEST_CONTEXT, layout);
      try {
        seed(store, DURABLE_VOLUME);
      } finally {
        store.close();
      }

      const context = (id: string) => ({
        clock: TEST_CLOCK,
        env: { CLAUDE_CODE_SESSION_ID: id },
        layout,
      });
      const times = { done: [] as number[], inbox: [] as number[], send: [] as number[] };
      for (let n = 0; n < SAMPLES; n++) {
        const id = uuid(DURABLE_VOLUME + 1 + n);
        let started = performance.now();
        // Each step is timed alone, in order, as separate CLI calls would run.
        // eslint-disable-next-line no-await-in-loop
        const sent = await storeSend(
          context(COORDINATOR),
          {},
          { body: `Measured ${n}.\n`, id, to: "archies-dog-walks/tech" },
        );
        times.send.push(performance.now() - started);
        expect(sent.wake.status).toBe("accepted");
        started = performance.now();
        // eslint-disable-next-line no-await-in-loop
        const inbox = await storeInbox(context(TECH), {}, {});
        times.inbox.push(performance.now() - started);
        expect(inbox.delivered).toBe(1);
        started = performance.now();
        // eslint-disable-next-line no-await-in-loop
        await storeDone(context(TECH), {}, id, { work: "ck-0017" });
        times.done.push(performance.now() - started);
      }
      const reopened = Store.forLayout(TEST_CONTEXT, layout);
      // Each sample records one send, one read, one close and the wake claim and outcome.
      const seededOpen = Math.ceil(DURABLE_VOLUME / 50);
      expect(reopened.head().seq).toBe(DURABLE_VOLUME * 2 - seededOpen + SAMPLES * 5);
      reopened.close();
      const result = Object.fromEntries(
        Object.entries(times).map(([verb, samples]) => [
          verb,
          {
            max: percentile(samples, 1),
            p50: percentile(samples, 0.5),
            p95: percentile(samples, 0.95),
          },
        ]),
      );
      process.stdout.write(
        `store performance (ms, ${DURABLE_VOLUME} journal messages): ${JSON.stringify(result)}\n`,
      );
      if (process.env.STORE_PERF_ASSERT === "1") {
        for (const verb of ["send", "inbox", "done"] as const) {
          expect(result[verb]!.p95, verb).toBeLessThan(200);
        }
      }
    },
  );
});
