// Bus events through the Claude channel spool and the Claude report sink. A producer pass records
// an attempt and its blocked event through the built recordEvent; flush passes deliver them.
import { rmSync } from "node:fs";
import { expect } from "vitest";

import {
  agents,
  Channel,
  clear,
  claudeGame,
  claudeRoute,
  eventRequestId,
  RECIPIENT,
} from "../lib/claude-fixture.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { flush, flushUntil, record } from "../lib/event-passes.ts";
import type { Json } from "../lib/json.ts";
import type { Workspace } from "../lib/workspace.ts";

type Event = { id: string; kind: string; message: string; sent: boolean; created: number };

const ATTEMPT = { kind: "attempt", key: "fixture-attempt", message: "scheduled attempt for main" };
const BLOCKED = { kind: "blocked-load", key: "fixture-attempt", message: "load at the limit" };

function spooled(ws: Workspace): Array<Json> {
  return ws
    .list("unblock", "claude-spool")
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, ...ws.readJson(`unblock/claude-spool/${name}`) }));
}

function events(ws: Workspace): Event[] {
  return ws.events() as unknown as Event[];
}

function eventReceipt(ws: Workspace, event: Event): Json {
  return ws.readJson(`events/native/${event.id}-${RECIPIENT}.json`);
}

function deliveryMessage(event: Event): string {
  const suffix = ` [bus event ${event.id.slice(0, 12)}]`;
  const body = Buffer.from(event.message, "utf8").subarray(0, 900 - Buffer.byteLength(suffix));
  return new TextDecoder("utf-8", { fatal: false }).decode(body).replace(/�+$/, "") + suffix;
}

/** A Claude game reporting to its recipient, with an attempt and its blocked event recorded. */
async function attemptBlocked(ws: Workspace): Promise<void> {
  claudeGame(ws, { recipient: true });
  await record(ws, ATTEMPT, BLOCKED);
}

suite("claude bus events", () => {
  const workspace = workspaces();

  contract(
    "an event is spooled once, deduplicated across flushes and accepted by the consumer",
    async () => {
      const ws = workspace();
      await attemptBlocked(ws);
      await flush(ws);
      const [first] = events(ws);
      expect(first!.kind).toBe("attempt");
      const requestId = eventRequestId(first!.id, RECIPIENT);
      const receipt = eventReceipt(ws, first!);
      expect([receipt.status, receipt.clientUserMessageId, receipt.attempts]).toEqual([
        "sending",
        requestId,
        [{ method: "claude-channel", status: "sending" }],
      ]);
      expect(JSON.stringify(receipt)).not.toContain(first!.message);
      expect(spooled(ws).map((entry) => entry.name)).toEqual([`${requestId}.json`]);
      expect(spooled(ws)[0]!.recipient).toBe(RECIPIENT);
      await flush(ws, 2);
      expect(spooled(ws).map((entry) => entry.name)).toEqual([`${requestId}.json`]);
      const channel = Channel.open(ws, [ws.path("unblock")]);
      try {
        channel.initialize();
        channel.initialized();
        await flushUntil(ws, () => channel.channel().length >= 2);
        await channel.collect(1_500);
      } finally {
        await channel.close();
      }
      const notifications = channel.channel();
      const [, second] = events(ws);
      expect(notifications.map((m) => m.params.meta.event_id)).toEqual([first!.id, second!.id]);
      expect(notifications[0]!.params.content).toBe(deliveryMessage(first!));
      expect(notifications[0]!.params.meta).toEqual({
        request_id: requestId,
        kind: "event",
        event_id: first!.id,
      });
      const accepted = eventReceipt(ws, first!);
      expect([accepted.status, accepted.attempts.at(-1).status]).toEqual(["accepted", "accepted"]);
      await flushUntil(ws, () => events(ws).every((event) => event.sent));
      expect(spooled(ws)).toEqual([]);
    },
  );

  contract(
    "the outbox stays unsent until the consumer accepts, then marks the event sent",
    async () => {
      const ws = workspace();
      await attemptBlocked(ws);
      await flush(ws, 3);
      expect(spooled(ws)).toHaveLength(1);
      expect(events(ws).map((event) => event.sent)).toEqual([false, false]);
      const channel = Channel.open(ws, [ws.path("unblock")]);
      try {
        channel.initialize();
        channel.initialized();
        await channel.waitFor(() => channel.channel().length >= 1);
        await flushUntil(ws, () => events(ws)[0]!.sent);
        await channel.collect(1_500);
      } finally {
        await channel.close();
      }
      expect(
        channel.channel().filter((m) => m.params.meta.event_id === events(ws)[0]!.id),
      ).toHaveLength(1);
      expect(String(channel.channel()[0]!.params.content)).toContain("scheduled attempt");
    },
  );

  contract(
    "an interrupted event send becomes ambiguous, is never resent and holds later events",
    async () => {
      const ws = workspace();
      await attemptBlocked(ws);
      await flush(ws);
      rmSync(ws.path("unblock", "claude-spool", spooled(ws)[0]!.name));
      const [first] = events(ws);
      await flush(ws);
      expect(eventReceipt(ws, first!).status).toBe("ambiguous");
      await flush(ws, 2);
      const receipt = eventReceipt(ws, first!);
      expect([receipt.status, receipt.attempts.at(-1).status]).toEqual(["ambiguous", "ambiguous"]);
      expect(spooled(ws)).toEqual([]);
      expect(events(ws).map((event) => event.sent)).toEqual([false, false]);
      expect(ws.list("events", "native")).toEqual([`${first!.id}-${RECIPIENT}.json`]);
    },
  );

  contract(
    "a missing recipient or absent clearance defers the event without spooling",
    async () => {
      const ws = workspace();
      await attemptBlocked(ws);
      agents(ws, "missing");
      await flush(ws);
      expect(ws.list("events", "native")).toHaveLength(1);
      const [first] = events(ws);
      expect(eventReceipt(ws, first!).status).toBe("deferred");
      clear(ws, RECIPIENT, "pending");
      agents(ws, "idle");
      await flush(ws, 2);
      expect(spooled(ws)).toEqual([]);
      expect(eventReceipt(ws, first!).status).toBe("deferred");
      clear(ws);
      await flush(ws);
      expect(spooled(ws)).toHaveLength(1);
      expect(eventReceipt(ws, first!).status).toBe("sending");
    },
  );

  contract(
    "events go to the channel only for the active route recipient and never fall back to Codex",
    async () => {
      const cases: Array<[string, (ws: Workspace) => void]> = [
        [
          "recipient is a route target",
          (ws) => (ws.config.reports = { project: "Fixture", recipient: "archie-tech" }),
        ],
        ["route held", (ws) => ws.writeRoute(claudeRoute(ws, { state: "held" }))],
      ];
      for (const [name, change] of cases) {
        const ws = workspace();
        await attemptBlocked(ws);
        change(ws);
        await flush(ws, 3);
        expect(spooled(ws), name).toEqual([]);
        expect(
          events(ws).map((event) => event.sent),
          name,
        ).toEqual([false, false]);
      }
    },
  );
});
