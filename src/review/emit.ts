// Events this kit produces itself, such as review health (`review-stuck`). Each goes straight to the
// store as a message from delivery-kit to the game's reports.recipient; it is never written to
// the runner's events.jsonl. The recipient is woken by the next send to it or the next review.
import type { GameLayout, Layout } from "../core/layout.ts";
import { Store } from "../store/db.ts";
import { clean, derivedId, type Notice, reportsRecipient, storeNotice } from "../store/notices.ts";
type HealthEmit = (kind: string, key: string, message: string) => void;

/** The stored form of one coordination event; its ID derives from (game, kind, key). */
export function coordinationNotice(
  to: string,
  game: GameLayout,
  project: string,
  event: { readonly kind: string; readonly key: string; readonly message: string },
): Notice {
  return {
    body: clean(`${project} bus: ${event.message}`),
    fallback: `${project} bus: ${event.kind}`,
    id: derivedId("coordination-event", game.id, event.kind, event.key),
    links: [{ kind: "event-kind", ref: event.kind }],
    to,
  };
}

/** The emit port for review health: one stored notice. */
export function coordinationEmit(layout: Layout, game: GameLayout, project: string): HealthEmit {
  return (kind, key, message) => {
    const store = Store.forLayout(layout);
    try {
      const notice = coordinationNotice(reportsRecipient(layout, game), game, project, {
        key,
        kind,
        message,
      });
      store.transaction(() => storeNotice(store, notice));
    } finally {
      store.close();
    }
  };
}
