import { describe, expect, it } from "vitest";

import { eventHash, normalizeLinks, sha256 } from "../../eventCodec.ts";
import { GENESIS, type JsonObject, type MessageLink, type StoredEvent } from "../../types.ts";
import { prepareCompactionCheckpoint } from "./checkpoint.ts";
import { qualifyClosedHistory } from "./closedHistory.ts";

const SENDER = { nativeId: "00000000-0000-4000-8000-000000000001", role: "sample-kit" };
const RECIPIENT = { nativeId: "00000000-0000-4000-8000-000000000002", role: "sample-app/tech" };
const SCOPE = {
  registeredGames: new Set(["sample-app"]),
  registeredRoles: new Set([SENDER.role, RECIPIENT.role]),
  registryRevision: 9,
};
const AT = "2026-11-20T00:00:00.000Z";
const BODY = "Synthetic message contents excluded from receipts.";

function fixture() {
  const events: StoredEvent[] = [];
  const head = () => events.at(-1) ?? { hash: GENESIS, seq: 0 };
  const append = (kind: string, actor: StoredEvent["actor"], payload: JsonObject) => {
    const seq = events.length + 1;
    const draft = {
      actor,
      at: AT,
      key: `${kind}:${seq}`,
      kind,
      payload,
      prevHash: head().hash,
      seq,
    };
    const event = { ...draft, hash: eventHash(draft) };
    events.push(event);
    return event;
  };
  const send = (id: string, links: readonly MessageLink[] = [], extra: JsonObject = {}) =>
    append("msg.sent", SENDER, {
      body: BODY,
      bodySha256: sha256(BODY),
      createdAt: AT,
      from: SENDER.role,
      id,
      intent: "queue",
      links: normalizeLinks(links).map(({ kind, ref }) => ({ kind, ref })),
      to: RECIPIENT.role,
      worker: null,
      ...extra,
    });
  const close = (id: string) => append("msg.closed", RECIPIENT, { id, state: "handled" });
  const closed = (id: string, links: readonly MessageLink[] = [], extra: JsonObject = {}) => {
    const original = send(id, links, extra);
    close(id);
    return original;
  };
  const window = () => {
    for (let offset = 0; offset < 100; offset += 1) {
      closed(`recent-${offset}`);
    }
  };
  const source = () => ({
    archives: [],
    events,
    previous: undefined,
    tail: { events, records: [] },
  });
  return { append, close, closed, events, head, send, source, window };
}

describe("one-time closed message history", () => {
  it("waives only individual replacement and produces a matching checkpoint selection", () => {
    const { append, closed, events, head, send, source, window } = fixture();
    const anchor = closed("cutover-anchor");
    const selected = closed("old-selected");
    const bad = closed("bad-reducer", [], { bodySha256: "invalid" });
    const review = closed("owned-by-review");
    append("review.brief", RECIPIENT, { messageId: "owned-by-review" });
    const unresolved = closed("wake-pending");
    append("wake.claimed", RECIPIENT, {
      harness: "codex",
      messages: ["wake-pending"],
      role: RECIPIENT.role,
      wake: "wake-1",
    });
    window();
    const open = send("still-open");
    const result = qualifyClosedHistory(source(), SCOPE, anchor);
    expect(result.selected).toEqual(["old-selected"]);
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        { id: "cutover-anchor", reason: "checkpoint-anchor-protected", seq: anchor.seq },
        { id: "bad-reducer", reason: "checkpoint-payload-unqualified", seq: bad.seq },
        { id: "owned-by-review", reason: "operational-body-reference", seq: review.seq },
        { id: "wake-pending", reason: "delivery-unresolved", seq: unresolved.seq },
        { id: "still-open", reason: "open-message", seq: open.seq },
        expect.objectContaining({ id: "recent-0", reason: "within-window" }),
      ]),
    );
    expect(result.excluded.map(({ seq }) => seq)).toEqual(
      result.excluded.map(({ seq }) => seq).sort((a, b) => a - b),
    );
    expect(JSON.stringify(result)).not.toContain(BODY);
    expect(result.registryRevision).toBe(SCOPE.registryRevision);
    expect(result.window).toBe(100);
    expect(qualifyClosedHistory(source(), SCOPE, anchor)).toEqual(result);
    const { checkpoint } = prepareCompactionCheckpoint(
      events,
      {
        ...SCOPE,
        verifiedEvidence: {
          head: head(),
          messageIds: new Set(result.selected),
          registryRevision: SCOPE.registryRevision,
          routineEventSequences: new Set(),
        },
      },
      anchor,
    );
    expect(checkpoint.entries[selected.seq - 1]?.event.payload.body).toBeUndefined();
    expect(checkpoint.entries[anchor.seq - 1]?.event.payload.body).toBe(BODY);
  });

  it("keeps exact canonical references, transitive message links and open or uncertain scope", () => {
    const { append, closed, send, source, window } = fixture();
    const anchor = append("store.migrated", RECIPIENT, {});
    const canonical = closed("canonical-notice", [{ kind: "message", ref: "child-notice" }]);
    const child = closed("child-notice", [{ kind: "message", ref: "leaf-notice" }]);
    const leaf = closed("leaf-notice");
    const held = closed("held-work", [{ kind: "work", ref: "sample-kit:sk-0001" }]);
    const answered = closed("known-closed", [
      { kind: "question", ref: "q-known" },
      { kind: "work", ref: "sample-kit:sk-0002" },
    ]);
    const unknown = closed("unknown-work", [{ kind: "work", ref: "sk-9999" }]);
    const pending = closed("pending-question", [{ kind: "question", ref: "q-pending" }]);
    const closeWork = send("close-work");
    const replacement = closed("close-replacement");
    append("msg.closed", RECIPIENT, {
      id: "close-work",
      state: "superseded",
      supersededBy: "close-replacement",
      work: "sample-kit:sk-0001",
    });
    append("work.started", SENDER, { id: "sk-0001", owner: SENDER.role, repository: "sample-kit" });
    append("work.finished", SENDER, {
      id: "sk-0002",
      owner: SENDER.role,
      repository: "sample-kit",
    });
    append("question.opened", SENDER, { id: "q-known", role: SENDER.role });
    append("question.answered", SENDER, { id: "q-known", role: SENDER.role });
    append("question.opened", SENDER, { id: "q-pending", role: SENDER.role });
    append("recovery.reconciled", SENDER, {
      receipts: ["Reviewed (message:journal:canonical-notice)."],
    });
    window();
    const result = qualifyClosedHistory(source(), SCOPE, anchor);
    expect(result.selected).toEqual([String(answered.payload.id)]);
    expect(result.excluded.slice(0, 8)).toEqual([
      { id: "canonical-notice", reason: "canonical-message-reference", seq: canonical.seq },
      { id: "child-notice", reason: "protected-message-reference", seq: child.seq },
      { id: "leaf-notice", reason: "protected-message-reference", seq: leaf.seq },
      { id: "held-work", reason: "open-work-reference", seq: held.seq },
      { id: "unknown-work", reason: "unknown-operational-reference", seq: unknown.seq },
      { id: "pending-question", reason: "open-question-reference", seq: pending.seq },
      { id: "close-work", reason: "open-work-reference", seq: closeWork.seq },
      { id: "close-replacement", reason: "protected-message-reference", seq: replacement.seq },
    ]);
  });

  it("fails closed when the restored source or its anchor differs", () => {
    const { closed, events, source, window } = fixture();
    const anchor = closed("anchor");
    window();
    expect(() => qualifyClosedHistory(source(), SCOPE, { ...anchor, hash: GENESIS })).toThrow(
      "checkpoint-anchor-mismatch",
    );
    events[events.length - 1] = { ...events.at(-1)!, hash: GENESIS };
    expect(() => qualifyClosedHistory(source(), SCOPE, anchor)).toThrow("checkpoint-source-chain");
  });

  it("keeps an existing reduction in the selected predecessor", () => {
    const { append, closed, events, head, window } = fixture();
    const anchor = append("store.migrated", RECIPIENT, {});
    const old = closed("previously-expired");
    closed("newly-qualified");
    window();
    const { checkpoint, receipt } = prepareCompactionCheckpoint(
      events,
      {
        ...SCOPE,
        verifiedEvidence: {
          head: head(),
          messageIds: new Set(["previously-expired"]),
          registryRevision: SCOPE.registryRevision,
          routineEventSequences: new Set(),
        },
      },
      anchor,
    );
    const later = append("registry.changed", RECIPIENT, {});
    const source = {
      archives: [],
      events: [...checkpoint.entries.map(({ event }) => event), later],
      previous: { checkpoint, selection: { ...receipt, id: "fixture-previous" } },
      tail: { events: [later], records: [] },
    };
    const result = qualifyClosedHistory(source, SCOPE, anchor);
    expect(result.head).toEqual({ hash: later.hash, seq: later.seq });
    expect(result.selected).toEqual(["newly-qualified"]);
    expect(result.excluded[0]).toEqual({
      id: "previously-expired",
      reason: "already-compacted",
      seq: old.seq,
    });
  });
});
