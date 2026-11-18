import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { captureAccounting } from "../accounting/boundary.ts";
import { holdLock, LockBusy } from "../lock.ts";
import { ProtocolStore } from "../protocol/core.ts";
import { type MessageWriter, ProtocolMessages } from "../protocol/messages.ts";
import { runtimeProtocolStore } from "../protocol/runtime.ts";
import { activateProtocolFixture } from "../protocol/testFixtures.ts";
import { claudeFixture, RECIPIENT, TECH } from "../review/fixtures.ts";
import { MessageService } from "./service.ts";
import { messageExpectation, MessageStore } from "./store.ts";

const AT = "2026-11-16T04:00:00.000Z";
const ROLE = "archies-dog-walks/tech";
const GUARDS = {
  artifacts: [],
  hold: "clear" as const,
  question: "pending" as const,
  references: ["fixture-own-question"],
};

async function fixture() {
  const game = claudeFixture();
  game.clear("pending");
  activateProtocolFixture(game.layout);
  const protocol = runtimeProtocolStore(game.layout)!;
  const binding = { harness: "claude" as const, nativeId: TECH };
  await protocol.claim({
    at: AT,
    binding,
    evidence: "fixture-sender",
    expectedEpoch: 0,
    role: "games/archies-dog-walks/tech",
  });
  const messages = new ProtocolMessages({ store: protocol });
  const envelope = {
    body: "Exact fixture original",
    created: AT,
    fromRole: "archies-dog-walks/tech",
    id: "00000000-0000-4000-8000-000000000077",
    intent: "queue" as const,
    schema: 1 as const,
    toRole: "game-coordinator",
  };
  const writer: MessageWriter = {
    at: AT,
    binding,
    epoch: 1,
    expectedRevision: 1,
    id: "publish-original",
    role: "games/archies-dog-walks/tech",
  };
  const original = await messages.publish(writer, {
    envelope,
    guards: GUARDS,
    links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
  });
  const service = new MessageService({ env: game.env, layout: game.layout });
  const input = {
    body: envelope.body,
    fromRole: envelope.fromRole,
    id: envelope.id,
    recipient: envelope.toRole,
  };
  return { ...game, envelope, input, messages, original, protocol, service, writer };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("protocol originals and legacy transport projections (isolated fixtures)", () => {
  it("requires the canonical original and recipient-owned receipt without clearing a pending question", async () => {
    const f = await fixture();
    const marker = join(f.unblock, "decisions", `${RECIPIENT}.json`);
    const before = readFileSync(marker, "utf8");
    await expect(
      f.service.send({ ...f.input, id: "00000000-0000-4000-8000-000000000078" }),
    ).rejects.toThrow("protocol-original-required");
    const queued = await f.service.send(f.input);
    expect(queued.envelope.created).toBe(AT);
    await expect(f.service.send({ ...f.input, body: "Changed shadow body" })).rejects.toThrow(
      "protocol-original-conflict",
    );
    await expect(
      f.service.reconcile({
        disposition: "handled",
        evidence: "fixture-unattested",
        expectedRevision: queued.revision,
        id: queued.envelope.id,
      }),
    ).rejects.toThrow("protocol-recipient-receipt-required");
    expect(f.service.view(queued).protocol).toEqual({
      disposition: null,
      handlingAttestation: "unattested",
    });
    const binding = { harness: "claude" as const, nativeId: RECIPIENT };
    await f.protocol.claim({
      at: AT,
      binding,
      evidence: "fixture-recipient",
      expectedEpoch: 0,
      role: "coordinator",
    });
    const evidence = await f.protocol.putArtifact(Buffer.from("Fixture local collection proof"));
    const receipt = await f.messages.receipt(
      {
        at: AT,
        binding,
        epoch: 1,
        expectedRevision: 1,
        id: "recipient-handled",
        role: "coordinator",
      },
      {
        disposition: "handled",
        evidence: [evidence],
        guards: GUARDS,
        id: "handled-receipt",
        original: f.original,
        retention: null,
      },
    );
    const handled = await f.service.reconcile({
      disposition: "handled",
      evidence: `protocol-receipt:${receipt.hash}`,
      expectedRevision: queued.revision,
      id: queued.envelope.id,
    });
    expect(handled.attempts).toEqual([]);
    expect(f.service.view(handled).protocol).toEqual({
      disposition: "handled",
      handlingAttestation: "attested",
    });
    expect(readFileSync(marker, "utf8")).toBe(before);
  });

  it("reads each protocol role state at most once for one recipient listing", async () => {
    const f = await fixture();
    const id = "00000000-0000-4000-8000-000000000079";
    await f.messages.publish(
      { ...f.writer, expectedRevision: 2, id: "publish-second-original" },
      {
        envelope: { ...f.envelope, id },
        guards: GUARDS,
        links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
      },
    );
    await f.service.send(f.input);
    await f.service.send({ ...f.input, id });
    const read = vi.spyOn(ProtocolStore.prototype, "read");
    const listing = f.service.status({ recipient: f.envelope.toRole });
    expect(listing.map((row) => row.id)).toEqual([f.envelope.id, id]);
    expect(listing.map((row) => row.protocol)).toEqual([
      { disposition: null, handlingAttestation: "unattested" },
      { disposition: null, handlingAttestation: "unattested" },
    ]);
    const roles = read.mock.calls.map(([role]) => role);
    expect(roles.length).toBeGreaterThan(0);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("validates only the originals addressed to the listing role, each once per read view", async () => {
    const f = await fixture();
    const evidence = await f.protocol.putArtifact(Buffer.from("Fixture guard evidence"));
    const guards = { ...GUARDS, artifacts: [evidence] };
    let revision = 2;
    const publish = (id: string, toRole: string) =>
      f.messages.publish(
        { ...f.writer, expectedRevision: revision, id: `publish-${revision++}` },
        {
          envelope: { ...f.envelope, id, toRole },
          guards,
          links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
        },
      );
    await publish("00000000-0000-4000-8000-000000000080", "game-coordinator");
    const reads = vi.spyOn(ProtocolStore.prototype, "readArtifact");
    const observed = [];
    let others = 0;
    for (const total of [1, 5]) {
      for (; others < total; others++) {
        // Sequential publications keep the sender journal revisions ordered.
        // eslint-disable-next-line no-await-in-loop
        await publish(`00000000-0000-4000-8000-00000000009${others}`, "game-kit");
      }
      reads.mockClear();
      const inbox = f.messages.inbox({
        recipientRole: "coordinator",
        senders: ["games/archies-dog-walks/tech"],
      });
      observed.push([inbox.messages.length, reads.mock.calls.length]);
    }
    expect(observed).toEqual([
      [2, 1],
      [2, 1],
    ]);
  });

  it("captures owner accounting from that owner's records alone, however many others are stored", async () => {
    const f = await fixture();
    await f.service.send(f.input);
    const binding = { harness: "claude" as const, nativeId: RECIPIENT };
    await f.protocol.claim({
      at: AT,
      binding,
      evidence: "fixture-recipient",
      expectedEpoch: 0,
      role: "coordinator",
    });
    const reads = vi.spyOn(
      MessageStore.prototype as unknown as Record<"load", (name: string) => unknown>,
      "load",
    );
    const observed = [];
    let sent = 0;
    for (const total of [1, 4]) {
      for (; sent < total; sent++) {
        const id = `00000000-0000-4000-8000-00000000010${sent}`;
        const body = `Fixture coordinator original ${sent}`;
        // Each publication is followed by its local send before the next revision.
        // eslint-disable-next-line no-await-in-loop
        await f.messages.publish(
          {
            at: AT,
            binding,
            epoch: 1,
            expectedRevision: sent + 1,
            id: `out-${sent}`,
            role: "coordinator",
          },
          {
            envelope: { ...f.envelope, body, fromRole: "game-coordinator", id, toRole: ROLE },
            guards: GUARDS,
            links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
          },
        );
        // eslint-disable-next-line no-await-in-loop
        await f.service.send({ body, fromRole: "game-coordinator", id, recipient: ROLE });
      }
      reads.mockClear();
      // eslint-disable-next-line no-await-in-loop
      await captureAccounting(f.layout, {}, "review", "message", ["game-coordinator"]);
      observed.push(reads.mock.calls.length);
    }
    expect(observed).toEqual([1, 1]);
  });

  it("pins the generation through an active attempt while preserving per-message exclusion and ambiguity", async () => {
    const f = await fixture();
    const queued = await f.service.send(f.input);
    const store = new MessageStore({
      layout: f.layout,
      resolveOwner: () => ({ harness: "claude", nativeId: RECIPIENT, parentBinding: null }),
    });
    const lease = await store.beginAttempt(messageExpectation(queued));
    const generation = join(f.layout.varDir, "work-protocol.lock");
    try {
      expect(() => holdLock(generation, { nonBlocking: true })).toThrow(LockBusy);
      await expect(store.beginAttempt(messageExpectation(queued))).rejects.toBeInstanceOf(LockBusy);
    } finally {
      lease.close();
    }
    expect(store.status(queued.envelope.id)?.state).toBe("ambiguous");
    holdLock(generation, { nonBlocking: true }).release();
    expect(store.read(queued.envelope.id)?.attempts).toHaveLength(1);
  });
});
