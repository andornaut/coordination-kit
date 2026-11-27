import { expect, it } from "vitest";

import { TEST_CLOCK } from "../../../core/testFixtures.ts";
import { MEMORY, Store } from "../../db.ts";
import { canonicalJson, sha256 } from "../../eventCodec.ts";
import { closeMessage, sendMessage } from "../../messages/messages.ts";
import { PROJECTIONS } from "../../projections.ts";
import { recordSession } from "../../sessions/handoffs.ts";
import type { StoredEvent } from "../../types.ts";
import type { CompactionCheckpoint } from "./checkpoint.ts";
import { verifyClosedHistoryReplay } from "./closedHistoryReplay.ts";
import type { FileCheckpointSource } from "./generation.ts";

const SENDER = { nativeId: "00000000-0000-4000-8000-000000000101", role: "sender" };
const RECIPIENT = { nativeId: "00000000-0000-4000-8000-000000000102", role: "recipient" };
const PRIOR = "00000000-0000-4000-8000-000000000103";
const SELECTED = "00000000-0000-4000-8000-000000000104";
const OPEN = "00000000-0000-4000-8000-000000000105";
const BODY = "A handled body with café text.";
type Entry = CompactionCheckpoint["entries"][number];

function reduced(event: StoredEvent, omit: string): Entry {
  const payload = Object.fromEntries(
    Object.entries(event.payload).filter(([name]) => name !== omit),
  );
  const compacted = { ...event, payload };
  return { event: compacted, reducedDigest: sha256(canonicalJson(compacted)) };
}

function receipt(checkpoint: CompactionCheckpoint) {
  return { digest: sha256(canonicalJson(checkpoint)), head: checkpoint.head };
}

function fixture() {
  const store = Store.open(TEST_CLOCK, MEMORY);
  try {
    const anchor = recordSession(store, RECIPIENT, {
      cwd: "/synthetic/start",
      harness: "codex",
      key: "anchor",
      version: "0.0.0-test",
    });
    sendMessage(store, SENDER, {
      body: "Previously expired.",
      id: PRIOR,
      intent: "queue",
      to: RECIPIENT.role,
    });
    closeMessage(store, RECIPIENT, PRIOR, {});
    const prefix = store.events();
    const previous: CompactionCheckpoint = {
      anchor: { hash: anchor.hash, seq: anchor.seq },
      entries: prefix.map((event) =>
        event.kind === "msg.sent" ? reduced(event, "body") : { event },
      ),
      head: store.head(),
      registryRevision: 1,
      schema: 2,
    };
    const selection = { ...receipt(previous), id: "00000000-0000-4000-8000-000000000106" };
    sendMessage(store, SENDER, { body: BODY, id: SELECTED, intent: "queue", to: RECIPIENT.role });
    closeMessage(store, RECIPIENT, SELECTED, {});
    sendMessage(store, SENDER, {
      body: "Leave this open.",
      id: OPEN,
      intent: "queue",
      to: RECIPIENT.role,
    });
    recordSession(store, RECIPIENT, {
      cwd: "/synthetic/recent",
      harness: "codex",
      key: "recent",
      version: "0.0.0-test",
    });

    const tail = store.events({ afterSeq: previous.head.seq });
    const source: FileCheckpointSource = {
      archives: [],
      events: [...previous.entries.map(({ event }) => event), ...tail],
      previous: { checkpoint: previous, selection },
      tail: { events: tail, records: [] },
    };
    const candidate: CompactionCheckpoint = {
      anchor: previous.anchor,
      entries: [...previous.entries, ...tail.map((event) => ({ event }))],
      head: store.head(),
      predecessor: selection,
      registryRevision: 1,
      schema: 2,
    };
    return { candidate, source };
  } finally {
    store.close();
  }
}

function compact(candidate: CompactionCheckpoint, ids: readonly string[]): CompactionCheckpoint {
  return {
    ...candidate,
    entries: candidate.entries.map(({ event, reducedDigest }) =>
      typeof event.payload.id === "string" &&
      event.kind === "msg.sent" &&
      ids.includes(event.payload.id)
        ? reduced(event, "body")
        : { event, ...(reducedDigest === undefined ? {} : { reducedDigest }) },
    ),
  };
}

it("compares every projection from a restored prior generation and its tail", () => {
  const { candidate, source } = fixture();
  const compacted = compact(candidate, [SELECTED]);
  const proof = verifyClosedHistoryReplay(source, compacted, receipt(compacted), [SELECTED]);
  expect(proof).toMatchObject({
    events: source.events.length,
    head: candidate.head,
    projections: { messages: { rows: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
    removedBodies: 1,
    removedBodyBytes: Buffer.byteLength(BODY),
    stateEquivalent: true,
  });
  expect(Object.keys(proof.projections)).toEqual(
    PROJECTIONS.flatMap(({ tables }) => tables).sort(),
  );
  expect(JSON.stringify(proof)).not.toContain(BODY);
});

it("rejects a missing removal, extra expiry and a previously expired selection", () => {
  const { candidate, source } = fixture();
  const selected = compact(candidate, [SELECTED]);
  const extra = compact(candidate, [SELECTED, OPEN]);
  for (const [checkpoint, ids] of [
    [candidate, [SELECTED]],
    [extra, [SELECTED]],
    [selected, [PRIOR, SELECTED]],
    [extra, [SELECTED, OPEN]],
  ] as const) {
    expect(() => verifyClosedHistoryReplay(source, checkpoint, receipt(checkpoint), ids)).toThrow(
      "closed-history-replay-mismatch",
    );
  }
});

it("rejects changes to a selected event's metadata and unrelated projection rows", () => {
  const { candidate, source } = fixture();
  const original = compact(candidate, [SELECTED]);
  const metadata = {
    ...candidate,
    entries: candidate.entries.map((entry) =>
      entry.event.kind === "msg.sent" && entry.event.payload.id === SELECTED
        ? reduced({ ...entry.event, payload: { ...entry.event.payload, to: "other-role" } }, "body")
        : entry,
    ),
  };
  const routine = {
    ...original,
    entries: original.entries.map((entry) =>
      entry.event === original.entries.at(-1)?.event ? reduced(entry.event, "cwd") : entry,
    ),
  };
  for (const checkpoint of [metadata, routine]) {
    expect(() =>
      verifyClosedHistoryReplay(source, checkpoint, receipt(checkpoint), [SELECTED]),
    ).toThrow("closed-history-replay-mismatch");
  }
});
