import { describe, expect, it } from "vitest";

import { type JsonObject, type StoredEvent } from "../types.ts";
import { fileRecords } from "./records.ts";

type FileRecordContext = NonNullable<Parameters<typeof fileRecords>[1]>;

const ART = "archies-dog-walks/art";
const TECH = "chibis-way-home/tech";
const COORDINATOR = "game-coordinator";
const PARENT_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_ID = "00000000-0000-4000-8000-000000000002";
const ART_PATH = "roles/archies-dog-walks%2Fart";
const TECH_PATH = "roles/chibis-way-home%2Ftech";
const CONTEXT: FileRecordContext = {
  registeredRoles: new Set([ART, TECH, COORDINATOR, "delivery-kit"]),
};

function event(
  seq: number,
  kind: string,
  role: string | null,
  payload: JsonObject,
  actor: Partial<StoredEvent["actor"]> = {},
): StoredEvent {
  return {
    actor: { nativeId: role === null ? null : PARENT_ID, role, ...actor },
    at: "2026-11-21T00:00:00.000Z",
    hash: seq.toString(16).padStart(64, "0"),
    key: `${kind}:${seq}`,
    kind,
    payload,
    prevHash: (seq - 1).toString(16).padStart(64, "0"),
    seq,
  };
}

function recordMap(events: readonly StoredEvent[], context = CONTEXT) {
  return Object.fromEntries(fileRecords(events, context).map(({ data, path }) => [path, data]));
}

describe("filesystem role records", () => {
  it("keeps exact sender originals and one body-free recipient disposition per transition", () => {
    const id = "legacy:123";
    const payload = { body: "Imported.", from: ART, id, state: "delivered", to: TECH };
    const events = [
      event(1, "msg.sent", ART, { body: "Original.", from: ART, id: "first", to: TECH }),
      event(2, "msg.sent", ART, { body: "Another.", from: ART, id: "second", to: TECH }),
      event(3, "msg.imported", COORDINATOR, payload),
      event(4, "inbox.read", TECH, { delivered: ["first", "second"], role: TECH }),
      event(5, "msg.retained", TECH, { id: "first", owner: ART, reason: "Waiting" }),
      event(6, "msg.closed", TECH, { id: "first", state: "handled" }),
      event(7, "inbox.read", TECH, { delivered: [], role: TECH }),
    ];
    const records = recordMap(events);

    expect(records[`${ART_PATH}/messages/originals/first.json`]).toMatchObject({
      payload: { body: "Original.", from: ART, id: "first", to: TECH },
    });
    expect(records[`${ART_PATH}/messages/originals/legacy%3A123.json`]).toMatchObject({
      payload: { body: "Imported.", id },
    });
    expect(records[`${TECH_PATH}/messages/dispositions/legacy%3A123/3.json`]).toMatchObject({
      payload: { from: ART, id, state: "delivered", to: TECH },
    });
    expect(records[`${TECH_PATH}/messages/dispositions/first/1.json`]).toMatchObject({
      payload: { from: ART, id: "first", state: "sent", to: TECH },
    });
    expect(records[`${TECH_PATH}/messages/dispositions/first/4.json`]).toMatchObject({
      payload: { id: "first", state: "delivered" },
    });
    expect(records[`${TECH_PATH}/messages/dispositions/second/4.json`]).toMatchObject({
      payload: { id: "second", state: "delivered" },
    });
    expect(records[`${TECH_PATH}/messages/dispositions/first/5.json`]).toMatchObject({
      payload: { id: "first", owner: ART },
    });
    expect(records[`${TECH_PATH}/messages/dispositions/first/6.json`]).toMatchObject({
      payload: { id: "first", state: "handled" },
    });
    expect(records[`${TECH_PATH}/inbox/reads/7.json`]).toMatchObject({
      payload: { delivered: [], role: TECH },
    });
    expect(
      JSON.stringify(Object.entries(records).filter(([path]) => path.startsWith(TECH_PATH))),
    ).not.toMatch(/Original\.|Another\.|Imported\./);
  });

  it("resolves owners from preceding transactions and quarantines mismatched receipts", () => {
    const events = [
      event(5, "inbox.read", TECH, { delivered: ["first", "other", "missing"], role: TECH }),
      event(6, "msg.closed", ART, { id: "first", state: "handled" }),
      event(7, "msg.retained", TECH, { id: "first", owner: ART }),
      event(8, "question.cancelled", TECH, { id: "ask" }),
      event(9, "request.closed", TECH, { id: "request-1" }),
      event(10, "hold.released", TECH, { id: "hold-1" }),
    ];
    const records = recordMap(events, {
      ...CONTEXT,
      messageOwner: (id) =>
        id === "first"
          ? { recipient: TECH, sender: ART }
          : id === "other"
            ? { recipient: ART, sender: TECH }
            : null,
      questionOwner: () => TECH,
      requestOwner: () => TECH,
      holdOwner: () => TECH,
    });
    expect(Object.keys(records)).toEqual([
      `${TECH_PATH}/messages/dispositions/first/5.json`,
      `${TECH_PATH}/inbox/reads/5.json`,
      "legacy/quarantine/5.json",
      "legacy/quarantine/6.json",
      `${TECH_PATH}/messages/dispositions/first/7.json`,
      `${TECH_PATH}/questions/ask/8.json`,
      `${TECH_PATH}/requests/request-1/9.json`,
      `${TECH_PATH}/holds/hold-1/10.json`,
    ]);
    expect(records["legacy/quarantine/5.json"]).toMatchObject({
      payload: { delivered: ["other", "missing"] },
      quarantine: "inbox-original-unverified",
    });
  });

  it("keeps decisions, work, requests, policy, handoffs and runner evidence under their owners", () => {
    const work = { id: "ck-0042", repository: "coordination-kit" };
    const handoff = "handoff-1";
    const hold = "handoff-handoff-1-chibis-way-home-tech";
    const events = [
      event(1, "question.opened", ART, { id: "ask", role: ART }),
      event(2, "question.answer-recorded", ART, { id: "ask", text: "Approval", work: work.id }),
      event(3, "question.answered", ART, { id: "ask", n: 1, role: ART, work: work.id }),
      event(4, "question.projection", ART, { id: "ask", status: "synced" }),
      event(5, "work.started", TECH, { ...work, owner: TECH }),
      event(6, "work.evidence", COORDINATOR, {
        ...work,
        source: "approval-ledger",
        stage: "verified",
      }),
      event(7, "work.retained", COORDINATOR, { ...work, owner: ART, source: "approval-ledger" }),
      event(8, "work.ready", TECH, work),
      event(9, "request.imported", COORDINATOR, { id: "request-1", owner: TECH }),
      event(10, "request.closed", TECH, { id: "request-1" }),
      event(11, "hold.imported", COORDINATOR, { id: "imported-hold", owner: TECH }),
      event(12, "hold.released", TECH, { id: "imported-hold" }),
      event(13, "hold.policy-set", COORDINATOR, {
        id: "policy-1",
        issuer: COORDINATOR,
        scope: `role:${TECH}`,
      }),
      event(14, "hold.policy-released", COORDINATOR, { id: "policy-1", issuer: COORDINATOR }),
      event(15, "handoff.opened", COORDINATOR, { id: handoff }),
      event(16, "handoff.ready", TECH, { id: handoff, role: TECH }),
      event(17, "hold.set", TECH, { id: hold, role: TECH }),
      event(18, "hold.released", COORDINATOR, { handoff, id: hold }),
      event(19, "store.retired", COORDINATOR, {}),
      event(20, "review.brief", "delivery-kit", {}),
      event(21, "bus.event", "delivery-kit", {}),
      event(22, "session.started", TECH, { role: TECH }),
      event(23, "wake.guarded", null, { role: TECH }),
      event(24, "hold.imported", COORDINATOR, { id: "unknown", owner: null }),
      event(25, "hold.policy-set", TECH, { id: "wrong-issuer", issuer: COORDINATOR }),
    ];
    expect(Object.keys(recordMap(events))).toEqual([
      `${ART_PATH}/questions/ask/1.json`,
      `${ART_PATH}/questions/ask/2.json`,
      `${ART_PATH}/questions/ask/3.json`,
      `${ART_PATH}/decisions/ck-0042/D1/3.json`,
      `${ART_PATH}/questions/ask/4.json`,
      `${TECH_PATH}/work/coordination-kit/ck-0042/5.json`,
      `${TECH_PATH}/work/coordination-kit/ck-0042/6.json`,
      `${TECH_PATH}/work/coordination-kit/ck-0042/7.json`,
      `${TECH_PATH}/work/coordination-kit/ck-0042/8.json`,
      `${TECH_PATH}/requests/request-1/9.json`,
      `${TECH_PATH}/requests/request-1/10.json`,
      `${TECH_PATH}/holds/imported-hold/11.json`,
      `${TECH_PATH}/holds/imported-hold/12.json`,
      "coordinator/holds/policy-1/13.json",
      "coordinator/holds/policy-1/14.json",
      "coordinator/handoffs/handoff-1/15.json",
      "coordinator/handoffs/handoff-1/16.json",
      `${TECH_PATH}/holds/${hold}/17.json`,
      "coordinator/handoffs/handoff-1/hold-releases/18.json",
      "coordinator/cutover/19.json",
      "coordinator/reviews/20.json",
      "coordinator/delivery/21.json",
      `${TECH_PATH}/sessions/22.json`,
      `${TECH_PATH}/inbox/wakes/23.json`,
      "legacy/quarantine/24.json",
      "legacy/quarantine/25.json",
    ]);
  });

  it("uses a proved child claim only for worker work and retains historical label attribution", () => {
    const work = { id: "ck-0042", owner: TECH, repository: "coordination-kit" };
    const labelled = event(1, "work.started", TECH, work, { worker: CHILD_ID });
    const verified = event(2, "work.evidence", TECH, work, { nativeId: CHILD_ID });
    const receipt = event(
      3,
      "inbox.read",
      TECH,
      { delivered: [], role: TECH },
      { nativeId: CHILD_ID },
    );
    const records = recordMap([labelled, verified, receipt], {
      ...CONTEXT,
      verifiedWorker: () => ({
        parentNativeId: PARENT_ID,
        parentRole: TECH,
        workerNativeId: CHILD_ID,
      }),
    });
    expect(records[`${TECH_PATH}/work/coordination-kit/ck-0042/1.json`]).toMatchObject({
      actor: { nativeId: PARENT_ID, worker: CHILD_ID },
    });
    expect(
      records[`${TECH_PATH}/workers/${CHILD_ID}/work/coordination-kit/ck-0042/2.json`],
    ).toMatchObject({ verifiedWorker: { parentRole: TECH } });
    expect(records[`${TECH_PATH}/inbox/reads/3.json`]).toMatchObject({
      verifiedWorker: { workerNativeId: CHILD_ID },
    });
  });

  it("quarantines unsafe or unregistered owners and encodes long IDs without truncation", () => {
    const long = `a${":".repeat(74)}.${":".repeat(180)}`;
    const records = recordMap([
      event(1, "msg.sent", TECH, { from: ART, id: "forged", to: TECH }),
      event(2, "msg.sent", ART, { from: ART, id: "../outside", to: TECH }),
      event(3, "msg.sent", ART, { from: ART, id: long, to: TECH }),
      event(4, "msg.imported", COORDINATOR, { from: "archived-role", id: "legacy", to: TECH }),
    ]);
    const path = Object.keys(records).find((key) => key.includes("/originals/%7E/"));
    expect(path?.split("/").every((part) => part.length <= 240 && !part.startsWith("."))).toBe(
      true,
    );
    const chunks = path!.split("/%7E/")[1]!.slice(0, -5).split("/");
    expect(decodeURIComponent(chunks.map((part) => part.slice(1)).join(""))).toBe(long);
    expect(records["legacy/quarantine/1.json"]).toMatchObject({
      quarantine: "message-sender-unverified",
    });
    expect(records["legacy/quarantine/2.json"]).toMatchObject({
      quarantine: "record-id-unverified",
    });
    expect(records["legacy/quarantine/4.json"]).toMatchObject({
      quarantine: "message-sender-unverified",
    });
    expect(() =>
      fileRecords([event(2, "inbox.read", TECH, {}), event(1, "inbox.read", TECH, {})], CONTEXT),
    ).toThrow("filesystem-event-order");
  });

  it("projects the same records for a replay and for a batch with preceding ownership", () => {
    const work = { id: "ck-0042", repository: "coordination-kit" };
    const initial = [
      event(1, "msg.sent", ART, { body: "Original.", from: ART, id: "first", to: TECH }),
      event(2, "work.started", TECH, { ...work, owner: TECH }),
      event(3, "question.opened", ART, { id: "ask", role: ART }),
    ];
    const batch = [
      event(4, "inbox.read", TECH, { delivered: ["first"], role: TECH }),
      event(5, "work.evidence", COORDINATOR, { ...work, source: "approval-ledger" }),
      event(6, "question.cancelled", ART, { id: "ask" }),
    ];
    expect(fileRecords([...initial, ...batch], CONTEXT)).toEqual([
      ...fileRecords(initial, CONTEXT),
      ...fileRecords(batch, {
        ...CONTEXT,
        messageOwner: () => ({ recipient: TECH, sender: ART }),
        questionOwner: () => ART,
        workOwner: () => TECH,
      }),
    ]);
  });
});
