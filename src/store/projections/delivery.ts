// Runner events, COMPLETE records, recorded work IDs and stored review briefs.
import { payloadJson as json, payloadText as text } from "../eventCodec.ts";
import type { ProjectionIndex } from "../projectionIndex.ts";
import type { Projection, StoredEvent } from "../types.ts";

const busEvent = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const id = text(p, "id");
  const game = text(p, "game");
  const type = text(p, "type");
  const key = text(p, "key");
  const kind = text(p, "kind");
  const at = text(p, "at");
  if (game === null || type === null || key === null || kind === null || at === null) {
    return;
  }
  const eventKey = [game, type, key];
  if ((id !== null && index.get("bus_events", [id])) || index.get("bus_event_keys", eventKey)) {
    return;
  }
  index.put("bus_events", [id ?? event.seq], {
    at,
    game,
    id,
    key,
    kind,
    seq: event.seq,
    sha: text(p, "sha"),
    status: text(p, "status"),
    type,
    work: json(p, "work"),
  });
  index.put("bus_event_keys", eventKey, { id });
};

const busComplete = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const game = text(p, "game");
  const sha = text(p, "sha");
  if (game === null || sha === null) {
    return;
  }
  const source = text(p, "source");
  if (source !== null && !index.get("bus_completes", [game, sha])) {
    index.put("bus_completes", [game, sha], {
      game,
      message_id: text(p, "messageId"),
      seq: event.seq,
      sha,
      source,
      work: json(p, "work"),
    });
  }
  // The first COMPLETE that lists a work ID records it for the game.
  for (const work of Array.isArray(p.work) ? (p.work as readonly unknown[]) : []) {
    if (typeof work === "string" && !index.get("bus_work", [game, work])) {
      index.put("bus_work", [game, work], { game, seq: event.seq, sha, work });
    }
  }
};

const reviewBrief = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const game = text(p, "game");
  const slot = Number(p.slot);
  const recipient = text(p, "recipient");
  const messageId = text(p, "messageId");
  if (
    game !== null &&
    recipient !== null &&
    messageId !== null &&
    !Number.isNaN(slot) &&
    !index.get("review_briefs", [game, slot])
  ) {
    index.put("review_briefs", [game, slot], {
      game,
      message_id: messageId,
      recipient,
      seq: event.seq,
      slot,
    });
  }
};

/** Runner events, COMPLETE records, recorded work IDs and stored review briefs. */
export const DELIVERY_PROJECTION: Projection = {
  apply: {
    "bus.complete": busComplete,
    "bus.event": busEvent,
    "review.brief": reviewBrief,
  },
  tables: ["bus_events", "bus_event_keys", "bus_completes", "bus_work", "review_briefs"],
};
