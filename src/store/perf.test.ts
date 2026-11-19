// Store cost on a synthetic store of about 30,000 messages. The CI assertions are bounds on rows
// and query plans; with STORE_PERF_ASSERT=1 the p95 latency of send, inbox and done through the
// CLI service (store open, registry fence, write and wake) must also stay under 200 ms.
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { Store } from "./db.ts";
import { closeMessage, sendMessage } from "./messages.ts";
import { storeDone, storeInbox, storeSend } from "./service.ts";
import { COORDINATOR, storeFixture, TECH } from "./testStore.ts";

const VOLUME = 30_000;
const SAMPLES = 60;
const ROLES = Array.from({ length: 24 }, (_, index) => `archies-dog-walks/role-${index}`);

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1]! * 10) / 10;
}

function plan(store: Store, sql: string, ...params: (string | number)[]): string {
  return (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
    .map((row) => row.detail)
    .join("; ");
}

describe("store performance", () => {
  it(
    "keeps send, inbox and done bounded on a store of 30,000 messages",
    { timeout: 600_000 },
    async () => {
      const { layout } = storeFixture();
      const store = Store.forLayout(layout);
      const sender = { nativeId: COORDINATOR, role: "game-coordinator" };
      for (let start = 0; start < VOLUME; start += 1000) {
        store.transaction(() => {
          for (let n = start; n < start + 1000; n++) {
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
      expect(
        Number((store.db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n),
      ).toBe(VOLUME);
      expect(
        plan(
          store,
          "SELECT * FROM messages WHERE to_role = ? AND state IN ('sent', 'delivered', 'retained') ORDER BY sent_seq",
          "x",
        ),
      ).toContain("USING INDEX messages_inbox");
      expect(plan(store, "SELECT * FROM messages WHERE id = ?", "x")).toContain(
        "USING INDEX sqlite_autoindex_messages_1",
      );
      expect(plan(store, "SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1")).toContain(
        "SCAN events",
      );
      expect(plan(store, "SELECT * FROM events WHERE key = ?", "x")).toContain(
        "USING INDEX sqlite_autoindex_events_1",
      );
      store.close();

      const context = (id: string) => ({ env: { CLAUDE_CODE_SESSION_ID: id }, layout });
      const times = { done: [] as number[], inbox: [] as number[], send: [] as number[] };
      for (let n = 0; n < SAMPLES; n++) {
        const id = uuid(VOLUME + 1 + n);
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
      const reopened = Store.forLayout(layout);
      // One event per send, read, close and wake claim and outcome: nothing scales with the store.
      expect(reopened.head().seq).toBe(VOLUME + (VOLUME - VOLUME / 50) + SAMPLES * 5);
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
        `store performance (ms, ${VOLUME} messages): ${JSON.stringify(result)}\n`,
      );
      if (process.env.STORE_PERF_ASSERT === "1") {
        for (const verb of ["send", "inbox", "done"] as const) {
          expect(result[verb]!.p95, verb).toBeLessThan(200);
        }
      }
    },
  );
});
