// Messages this kit stores on the runner's behalf: runner events, COMPLETE, review briefs and
// review health. The sender is `delivery-kit`, the runner's registry role; IDs derive from what
// the message is about, so a repeated call stores nothing new.
import { NAMESPACE_URL, uuid5 } from "../adapters/shared/ids.ts";
import { loadReportsConfig } from "../config.ts";
import type { GameLayout, Layout } from "../layout.ts";
import { resolveRole } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";
import type { Store } from "./db.ts";
import { sendMessage } from "./messages.ts";
import { secretShape } from "./secrets.ts";
import type { Actor, MessageLink } from "./types.ts";

/** The runner's role in the registry, the sender of every message this module stores. */
export const DELIVERY_KIT_ROLE = "delivery-kit";
export const DELIVERY_KIT_ACTOR: Actor = { nativeId: null, role: DELIVERY_KIT_ROLE };

/** A UUID derived from its parts, stable across processes and releases. */
export function derivedId(...parts: readonly (string | number)[]): string {
  return uuid5(NAMESPACE_URL, `coordination-store:${parts.join(":")}`);
}

/** The game's `reports.recipient`, resolved through the registry when it can be read. */
export function reportsRecipient(layout: Layout, game: GameLayout): string {
  const role = loadReportsConfig(game.configFile).reports.recipient;
  try {
    return resolveRole(readRegistry(layout), role);
  } catch {
    return role;
  }
}

export interface Notice {
  readonly id: string;
  readonly to: string;
  readonly body: string;
  /** The same body without its free-text detail, stored when the body is secret-shaped. */
  readonly fallback: string;
  readonly links?: readonly MessageLink[];
}

/**
 * Store one notice from delivery-kit unless its ID is already stored. Returns true when this call
 * stored it. Runs in the caller's transaction.
 */
export function storeNotice(store: Store, notice: Notice): boolean {
  if (store.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(notice.id) !== undefined) {
    return false;
  }
  const body = secretShape(notice.body) === null ? notice.body : notice.fallback;
  return !sendMessage(store, DELIVERY_KIT_ACTOR, {
    body,
    id: notice.id,
    intent: "queue",
    links: notice.links ?? [],
    to: notice.to,
  }).duplicate;
}
