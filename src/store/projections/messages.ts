// Messages, the per-role wake state and the wake attempts.
import { payloadJson as json, payloadText as text } from "../eventCodec.ts";
import type { ProjectionIndex, ProjectionRow } from "../projectionIndex.ts";
import { ensure, type JsonObject, type Projection, type StoredEvent } from "../types.ts";

function setPending(index: ProjectionIndex, role: string): void {
  const current = index.get("wake_state", [role]);
  index.put("wake_state", [role], { outstanding: current?.outstanding ?? null, pending: 1, role });
}

function original(index: ProjectionIndex, event: StoredEvent): void {
  const p = event.payload;
  const id = text(p, "id")!;
  const to = text(p, "to")!;
  const imported = event.kind === "msg.imported";
  const state = imported ? text(p, "state") : "sent";
  ensure(index.get("messages", [id]) === undefined, "message-id-conflict");
  index.put("messages", [id], {
    body: text(p, "body") ?? "",
    body_sha256: text(p, "bodySha256"),
    closed_at: imported ? text(p, "closedAt") : null,
    created_at: text(p, "createdAt"),
    delivered_at: imported ? text(p, "deliveredAt") : null,
    evidence: imported ? json(p, "evidence") : "[]",
    from_role: text(p, "from"),
    id,
    intent: text(p, "intent"),
    legacy: imported ? json(p, "legacy") : null,
    links: json(p, "links"),
    retention:
      imported && p.retention !== null && typeof p.retention === "object"
        ? JSON.stringify({ ...(p.retention as JsonObject), at: event.at })
        : null,
    sent_seq: event.seq,
    state,
    superseded_by: imported ? text(p, "supersededBy") : null,
    to_role: to,
    unconfirmed: imported && p.unconfirmed === true ? 1 : 0,
    updated_at: event.at,
    updated_seq: event.seq,
    work: imported ? text(p, "work") : null,
    worker: imported ? null : text(p, "worker"),
  });
  if (state === "sent") {
    setPending(index, to);
  }
}

function updateMessage(
  index: ProjectionIndex,
  event: StoredEvent,
  id: string,
  current: ProjectionRow,
  changes: ProjectionRow,
): void {
  index.put("messages", [id], {
    ...current,
    ...changes,
    updated_at: event.at,
    updated_seq: event.seq,
  });
}

function inboxRead(index: ProjectionIndex, event: StoredEvent): void {
  const role = text(event.payload, "role")!;
  for (const id of (event.payload.delivered as readonly string[] | undefined) ?? []) {
    const row = index.get("messages", [id]);
    if (row?.to_role === role && row.state === "sent") {
      updateMessage(index, event, id, row, { delivered_at: event.at, state: "delivered" });
    }
  }
  index.put("wake_state", [role], { outstanding: null, pending: 0, role });
}

function closed(index: ProjectionIndex, event: StoredEvent): void {
  const p = event.payload;
  const id = text(p, "id")!;
  const row = index.get("messages", [id]);
  if (row === undefined) {
    return;
  }
  // A journal may hold generated coordinator attention closed without delivery.
  const retiredAttention =
    event.actor.role === "game-coordinator" &&
    event.actor.nativeId === null &&
    Array.isArray(p.evidence) &&
    p.evidence[0] === "attention-source-cleared";
  updateMessage(index, event, id, row, {
    closed_at: event.at,
    delivered_at: row.delivered_at ?? (retiredAttention ? null : event.at),
    evidence: json(p, "evidence"),
    state: text(p, "state"),
    superseded_by: text(p, "supersededBy"),
    work: text(p, "work"),
  });
}

function retained(index: ProjectionIndex, event: StoredEvent): void {
  const p = event.payload;
  const id = text(p, "id")!;
  const row = index.get("messages", [id]);
  if (row === undefined) {
    return;
  }
  updateMessage(index, event, id, row, {
    delivered_at: row.delivered_at ?? event.at,
    evidence: p.evidence === undefined ? row.evidence! : json(p, "evidence"),
    retention: JSON.stringify({
      at: event.at,
      nextBoundary: text(p, "nextBoundary"),
      owner: text(p, "owner"),
      reason: text(p, "reason"),
    }),
    state: "retained",
  });
}

function wakeAttempt(index: ProjectionIndex, event: StoredEvent): void {
  const p = event.payload;
  const id = text(p, "wake")!;
  const role = text(p, "role")!;
  const guarded = event.kind === "wake.guarded";
  ensure(index.get("wakes", [id]) === undefined, "wake-id-conflict");
  index.put("wakes", [id], {
    at: event.at,
    completed_at: guarded ? event.at : null,
    conversation: guarded ? null : text(p, "conversation"),
    count: Number(p.count),
    detail: guarded ? text(p, "reason") : null,
    harness: text(p, "harness"),
    id,
    outcome: guarded ? "guarded" : null,
    role,
    seq: event.seq,
  });
  if (!guarded) {
    const row = index.get("wake_state", [role]);
    index.put("wake_state", [role], { outstanding: id, pending: row?.pending ?? 1, role });
  }
}

function clearWake(index: ProjectionIndex, role: string, expected?: string | null): void {
  const row = index.get("wake_state", [role]);
  if (row !== undefined && (expected === undefined || row.outstanding === expected)) {
    index.put("wake_state", [role], { ...row, outstanding: null });
  }
}

function wakeCompleted(index: ProjectionIndex, event: StoredEvent): void {
  const p = event.payload;
  const id = text(p, "wake")!;
  const row = index.get("wakes", [id]);
  if (row !== undefined) {
    index.put("wakes", [id], {
      ...row,
      completed_at: event.at,
      detail: text(p, "detail"),
      outcome: text(p, "outcome"),
    });
  }
  // A wake refused before any native action leaves nothing outstanding.
  if (p.outcome === "guarded") {
    clearWake(index, text(p, "role")!, id);
  }
}

/** A journal may hold native notice proofs, each of which ended its exact outstanding wake. */
function noticeEnded(index: ProjectionIndex, { payload }: StoredEvent): void {
  const id = text(payload, "id");
  if (id !== null) {
    clearWake(index, text(payload, "role")!, id);
  }
}

export const MESSAGES_PROJECTION: Projection = {
  apply: {
    "inbox.read": inboxRead,
    "msg.closed": closed,
    "msg.imported": original,
    "msg.retained": retained,
    "msg.sent": original,
    "notice.consumed": noticeEnded,
    "notice.released": noticeEnded,
    "wake.claimed": wakeAttempt,
    "wake.completed": wakeCompleted,
    "wake.guarded": wakeAttempt,
    "wake.rearmed": (index, { payload }) => clearWake(index, text(payload, "role")!),
  },
  tables: ["messages", "wake_state", "wakes"],
};
