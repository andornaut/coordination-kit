import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Clock } from "../../core/clock.ts";
import { Store } from "../db.ts";
import { SECRET_SHAPES, secretShape } from "../secrets.ts";
import {
  closeMessage,
  exportSince,
  messageHistory,
  messageStatus,
  readInbox,
  retainMessage,
  sendMessage,
} from "./messages.ts";

const COORDINATOR = { nativeId: "00000000-0000-4000-8000-00000000000a", role: "game-coordinator" };
const TECH = { nativeId: "00000000-0000-4000-8000-00000000000b", role: "archies-dog-walks/tech" };
const ART = { nativeId: "00000000-0000-4000-8000-00000000000c", role: "archies-dog-walks/art" };
const ID = "00000000-0000-4000-8000-000000000101";
const OTHER = "00000000-0000-4000-8000-000000000102";

function clock(): Clock {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 10, 18, 12, 0, tick++));
}

function open(): Store {
  return Store.open(clock(), join(mkdtempSync(join(tmpdir(), "store-msg-")), "coordination.db"));
}

function send(store: Store, id = ID, body = "Please review.\n") {
  return sendMessage(store, COORDINATOR, {
    body,
    id,
    intent: "queue",
    links: [{ kind: "work", ref: "ck-0017" }],
    to: TECH.role,
  });
}

describe("sendMessage", () => {
  it("commits the original with its body hash and links, sent and wake-pending", () => {
    const store = open();
    const { duplicate, message } = send(store);
    expect(duplicate).toBe(false);
    expect(message).toMatchObject({
      bodySha256: createHash("sha256").update("Please review.\n").digest("hex"),
      from: "game-coordinator",
      id: ID,
      intent: "queue",
      links: [{ kind: "work", ref: "ck-0017" }],
      state: "sent",
      to: "archies-dog-walks/tech",
      unconfirmed: false,
    });
    expect(message).not.toHaveProperty("body");
    expect(messageStatus(store, ID, true).body).toBe("Please review.\n");
    expect(
      store.db.prepare("SELECT pending FROM wake_state WHERE role = ?").get(TECH.role),
    ).toEqual({ pending: 1 });
    expect(store.events().map((event) => event.key)).toEqual([`msg.sent:${ID}`]);
  });

  it("treats the same ID and content as a no-op and refuses changed content", () => {
    const store = open();
    send(store);
    expect(send(store).duplicate).toBe(true);
    expect(store.events()).toHaveLength(1);
    expect(() => send(store, ID, "Changed.\n")).toThrow("id-conflict");
    expect(() =>
      sendMessage(store, ART, {
        body: "Please review.\n",
        id: ID,
        intent: "queue",
        links: [{ kind: "work", ref: "ck-0017" }],
        to: TECH.role,
      }),
    ).toThrow("id-conflict");
  });

  it("refuses invalid IDs, roles, links, empty and oversized bodies", () => {
    const store = open();
    expect(() =>
      sendMessage(store, COORDINATOR, { body: "x", id: "bad id", intent: "queue", to: TECH.role }),
    ).toThrow("invalid-id");
    expect(() =>
      sendMessage(store, COORDINATOR, { body: "x", id: ID, intent: "queue", to: "Bad Role" }),
    ).toThrow("invalid-role");
    expect(() =>
      sendMessage(store, COORDINATOR, { body: "", id: ID, intent: "queue", to: TECH.role }),
    ).toThrow("empty-body");
    expect(() =>
      sendMessage(store, COORDINATOR, {
        body: "x".repeat(1024 * 1024 + 1),
        id: ID,
        intent: "queue",
        to: TECH.role,
      }),
    ).toThrow("body-too-large");
    expect(() =>
      sendMessage(store, COORDINATOR, {
        body: "x",
        id: ID,
        intent: "queue",
        links: [{ kind: "Work", ref: "x" }],
        to: TECH.role,
      }),
    ).toThrow("invalid-link");
  });
});

describe("secret-shaped bodies", () => {
  // Test strings are assembled at run time so no token shape appears in the source.
  const repeat = (unit: string, count: number) => unit.repeat(count);
  const shaped: Record<string, string> = {
    "anthropic-key": ["sk", "ant", repeat("a1", 16)].join("-"),
    "aws-access-key": ["AK", "IA", repeat("Q", 16)].join(""),
    "bearer-token": `Authorization: ${["Bea", "rer"].join("")} ${repeat("x9", 16)}`,
    "github-token": `${["gh", "p_"].join("")}${repeat("A1", 20)}`,
    "google-api-key": `${["AI", "za"].join("")}${repeat("b", 35)}`,
    jwt: [`${"ey"}J${repeat("h", 10)}`, `${"ey"}J${repeat("p", 10)}`, repeat("s", 12)].join("."),
    "npm-token": `${["np", "m_"].join("")}${repeat("c", 36)}`,
    "openai-key": `${["s", "k-"].join("")}${repeat("d", 40)}`,
    "private-key": `${repeat("-", 5)}BEGIN OPENSSH ${["PRIV", "ATE"].join("")} KEY${repeat("-", 5)}`,
    "slack-token": `${["xo", "xb"].join("")}-${repeat("1", 12)}`,
    "url-credentials": `https://user:${repeat("p", 8)}@example.invalid/`,
  };

  it("names a shape for every pattern and refuses the send without writing", () => {
    const store = open();
    expect(Object.keys(shaped).sort()).toEqual(SECRET_SHAPES.map((shape) => shape.name).sort());
    for (const [name, sample] of Object.entries(shaped)) {
      expect(secretShape(`context ${sample} context`), name).toBe(name);
      expect(() => send(store, ID, `Here: ${sample}\n`), name).toThrow("secret-shaped-body");
    }
    expect(store.events()).toHaveLength(0);
  });

  it("accepts ordinary coordination text", () => {
    for (const body of [
      "Reason tokens: outbox-unreadable, cli-error.",
      "Use the credential reference faramir://home/router/admin.",
      "Commit 0123456789abcdef0123456789abcdef01234567 is on main.",
      "https://github.com/andornaut/coordination-kit/blob/main/docs/reference/store.md",
    ]) {
      expect(secretShape(body), body).toBeNull();
    }
  });
});

describe("message lifecycle", () => {
  it("delivers on the recipient's own read once, and clears its wake state", () => {
    const store = open();
    send(store);
    send(store, OTHER, "Second.\n");
    expect(readInbox(store, COORDINATOR).messages).toEqual([]);
    const first = readInbox(store, TECH, { includeBody: true });
    expect(first.delivered).toBe(2);
    expect(first.messages.map((message) => [message.id, message.state, message.body])).toEqual([
      [ID, "delivered", "Please review.\n"],
      [OTHER, "delivered", "Second.\n"],
    ]);
    const events = store.events().length;
    const second = readInbox(store, TECH);
    expect(second.delivered).toBe(0);
    expect(
      second.messages.every(
        (message) => message.state === "delivered" && message.body === undefined,
      ),
    ).toBe(true);
    expect(store.events()).toHaveLength(events);
    expect(
      store.db.prepare("SELECT pending, outstanding FROM wake_state WHERE role = ?").get(TECH.role),
    ).toEqual({
      outstanding: null,
      pending: 0,
    });
  });

  it("lets only the recipient deliver, close or retain its messages", () => {
    const store = open();
    send(store);
    expect(() => closeMessage(store, COORDINATOR, ID)).toThrow("not-recipient");
    expect(() => closeMessage(store, ART, ID)).toThrow("not-recipient");
    expect(() =>
      retainMessage(store, ART, ID, {
        nextBoundary: "next review",
        owner: ART.role,
        reason: "mine",
      }),
    ).toThrow("not-recipient");
    expect(() => closeMessage(store, TECH, OTHER)).toThrow("missing");
    expect(messageStatus(store, ID).state).toBe("sent");
  });

  it("closes in one write, repeats identically as a no-op and refuses any other change", () => {
    const store = open();
    send(store);
    const closed = closeMessage(store, TECH, ID, {
      evidence: ["commit:abc123", "commit:abc123"],
      work: "ck-0017",
    });
    expect(closed.duplicate).toBe(false);
    expect(closed.message).toMatchObject({
      evidence: ["commit:abc123"],
      state: "handled",
      supersededBy: null,
      work: "ck-0017",
    });
    expect(closed.message.deliveredAt).not.toBeNull();
    expect(closed.message.closedAt).not.toBeNull();
    expect(
      closeMessage(store, TECH, ID, { evidence: ["commit:abc123"], work: "ck-0017" }).duplicate,
    ).toBe(true);
    expect(() => closeMessage(store, TECH, ID, { work: "ck-0018" })).toThrow("already-closed");
    expect(() =>
      retainMessage(store, TECH, ID, {
        nextBoundary: "next review",
        owner: TECH.role,
        reason: "late",
      }),
    ).toThrow("already-closed");
    expect(store.events().filter((event) => event.kind === "msg.closed")).toHaveLength(1);
  });

  it("supersedes only with an existing other message", () => {
    const store = open();
    send(store);
    expect(() => closeMessage(store, TECH, ID, { supersededBy: ID })).toThrow(
      "invalid-superseded-by",
    );
    expect(() => closeMessage(store, TECH, ID, { supersededBy: OTHER })).toThrow(
      "invalid-superseded-by",
    );
    send(store, OTHER, "Newer.\n");
    expect(closeMessage(store, TECH, ID, { supersededBy: OTHER }).message).toMatchObject({
      state: "superseded",
      supersededBy: OTHER,
    });
  });

  it("retains with owner, reason and boundary, then closes", () => {
    const store = open();
    send(store);
    const retention = {
      nextBoundary: "2026-11-18T13:30-05:00 review",
      owner: ART.role,
      reason: "needs art",
    };
    const retained = retainMessage(store, TECH, ID, retention);
    expect(retained.message.state).toBe("retained");
    expect(retained.message.retention).toMatchObject({
      nextBoundary: retention.nextBoundary,
      owner: ART.role,
      reason: "needs art",
    });
    expect(retainMessage(store, TECH, ID, retention).duplicate).toBe(true);
    expect(
      retainMessage(store, TECH, ID, { ...retention, reason: "still needs art" }).duplicate,
    ).toBe(false);
    expect(readInbox(store, TECH).messages.map((message) => message.state)).toEqual(["retained"]);
    expect(closeMessage(store, TECH, ID).message.state).toBe("handled");
    expect(readInbox(store, TECH).messages).toEqual([]);
    expect(readInbox(store, TECH, { all: true }).messages.map((message) => message.state)).toEqual([
      "handled",
    ]);
    expect(() => retainMessage(store, TECH, OTHER, { ...retention, reason: " " })).toThrow(
      "invalid-retention",
    );
  });
});

describe("history and export", () => {
  it("lists message events in order without bodies, by role and time", () => {
    const store = open();
    send(store);
    sendMessage(store, TECH, { body: "Reply.\n", id: OTHER, intent: "unblock", to: ART.role });
    readInbox(store, TECH);
    closeMessage(store, TECH, ID);
    const all = messageHistory(store);
    expect(all.map((entry) => entry.kind)).toEqual([
      "msg.sent",
      "msg.sent",
      "inbox.read",
      "msg.closed",
    ]);
    expect(JSON.stringify(all)).not.toContain("Please review.");
    expect(all[0]?.detail).toMatchObject({
      from: "game-coordinator",
      id: ID,
      to: "archies-dog-walks/tech",
    });
    expect(messageHistory(store, { role: ART.role }).map((entry) => entry.detail.id)).toEqual([
      OTHER,
    ]);
    expect(messageHistory(store, { since: all[2]!.at }).map((entry) => entry.kind)).toEqual([
      "inbox.read",
      "msg.closed",
    ]);
    expect(messageHistory(store, { limit: 1 })).toHaveLength(1);
  });

  it("exports sends with bodies and closes recorded after a time", () => {
    const store = open();
    send(store);
    const cutover = messageHistory(store)[0]!.at;
    sendMessage(store, TECH, {
      body: "After cutover.\n",
      id: OTHER,
      intent: "queue",
      to: ART.role,
    });
    readInbox(store, TECH);
    closeMessage(store, TECH, ID, { work: "ck-0017" });
    const exported = exportSince(store, cutover);
    expect(exported.messages.map((message) => [message.id, message.body])).toEqual([
      [OTHER, "After cutover.\n"],
    ]);
    expect(exported.closes).toEqual([
      expect.objectContaining({
        actor: TECH.role,
        id: ID,
        kind: "msg.closed",
        state: "handled",
        work: "ck-0017",
      }),
    ]);
  });
});
