// The scheduled review brief in store mode: one stored message from delivery-kit to the route
// recipient per (game, slot), capped at one page (60 lines, 4096 bytes) of counts and exceptions.
// `review show` prints the full record. The message ID derives from (game, slot), so a repeated
// call stores nothing and returns the recorded result. Native transports only wake.
import type { SQLInputValue } from "node:sqlite";

import { readRoleRoute, RouteError, routeRecipient } from "../adapters/shared/route.ts";
import type { GameLayout, Layout } from "../layout.ts";
import { resolveRole } from "../registry/resolve.ts";
import { readRegistry } from "../registry/store.ts";
import { Store } from "../store/db.ts";
import { DELIVERY_KIT_ACTOR, derivedId, storeNotice } from "../store/notices.ts";
import { type Json, type JsonObject, StoreError } from "../store/types.ts";
import {
  pendingWakeRoles,
  rearmWake,
  type WakePorts,
  wakeRecipient,
  wakeState,
} from "../store/wake.ts";
import type { ReviewResult } from "./deliver.ts";
import { coordinationNotice } from "./emit.ts";

export const BRIEF_MAX_LINES = 60;
export const BRIEF_MAX_BYTES = 4096;

type Row = Record<string, SQLInputValue>;

export interface StoreReviewContext {
  readonly layout: Layout;
  readonly env: NodeJS.ProcessEnv;
  readonly ports?: WakePorts;
  readonly now?: () => string;
}

/** The route recipient for this game's slot, or the typed result that ends the review. */
function routeFor(layout: Layout, game: GameLayout): string | ReviewResult {
  let recipient: string;
  try {
    const route = readRoleRoute(layout);
    if (route === null || route.host !== game.id) {
      return {
        detail: route === null ? "no review route" : "this game does not host the review route",
        reason: "nothing-due",
        status: "skipped",
      };
    }
    if (route.state === "held") {
      return { detail: "review route held", reason: "held", status: "skipped" };
    }
    recipient = routeRecipient(layout, route);
  } catch (error) {
    if (error instanceof RouteError) {
      return {
        detail:
          "review route is unavailable or invalid; its owner must verify identities and ownership",
        reason: "route-unavailable",
        status: "deferred",
      };
    }
    throw error;
  }
  try {
    return resolveRole(readRegistry(layout), recipient);
  } catch {
    return {
      detail: "the review recipient is not a registered role",
      reason: "recipient-unavailable",
      status: "deferred",
    };
  }
}

export interface BriefException {
  readonly kind: "stalled" | "unconfirmed" | "wake-failed" | "wake-ambiguous" | "wake-guarded";
  readonly role: string;
  readonly id?: string;
  readonly state?: string;
  readonly detail?: string;
}

export interface BriefRecord {
  readonly game: string;
  readonly slot: number;
  readonly recipient: string;
  readonly messageId: string;
  readonly counts: JsonObject;
  readonly exceptions: readonly BriefException[];
  /** Open (sent, delivered or retained) message IDs at this slot, for the next slot's ages. */
  readonly open: readonly string[];
  readonly result: ReviewResult;
}

function previousBrief(store: Store, game: string, slot: number): BriefRecord | undefined {
  const row = store.db
    .prepare(
      `SELECT e.payload FROM review_briefs b JOIN events e ON e.seq = b.seq
       WHERE b.game = ? AND b.slot < ? ORDER BY b.slot DESC LIMIT 1`,
    )
    .get(game, slot) as Row | undefined;
  return row === undefined ? undefined : (JSON.parse(row.payload as string) as BriefRecord);
}

function recordedBrief(store: Store, game: string, slot: number): BriefRecord | undefined {
  const row = store.db
    .prepare(
      `SELECT e.payload FROM review_briefs b JOIN events e ON e.seq = b.seq
       WHERE b.game = ? AND b.slot = ?`,
    )
    .get(game, slot) as Row | undefined;
  return row === undefined ? undefined : (JSON.parse(row.payload as string) as BriefRecord);
}

/** Counts and exceptions from the store as it is now; the previous brief ages open messages. */
function survey(
  store: Store,
  previous: BriefRecord | undefined,
): Omit<BriefRecord, "game" | "slot" | "recipient" | "messageId" | "result"> {
  const rows = store.db
    .prepare(
      `SELECT id, to_role, state, unconfirmed FROM messages
       WHERE state IN ('sent', 'delivered', 'retained') ORDER BY to_role, sent_seq`,
    )
    .all() as Row[];
  const before = new Set(previous?.open ?? []);
  const byRole: Record<string, Record<string, number>> = {};
  const states: Record<string, number> = { delivered: 0, retained: 0, sent: 0 };
  const exceptions: BriefException[] = [];
  let unconfirmed = 0;
  for (const row of rows) {
    const role = row.to_role as string;
    const state = row.state as string;
    const id = row.id as string;
    states[state] = (states[state] ?? 0) + 1;
    const counts = (byRole[role] ??= { delivered: 0, retained: 0, sent: 0 });
    counts[state] = (counts[state] ?? 0) + 1;
    if (Number(row.unconfirmed) === 1) {
      unconfirmed += 1;
      exceptions.push({ id, kind: "unconfirmed", role, state });
    } else if (state !== "retained" && before.has(id)) {
      exceptions.push({ id, kind: "stalled", role, state });
    }
  }
  const wakes = { ambiguous: 0, failed: 0, guarded: 0, outstanding: 0 };
  const outstanding = store.db
    .prepare(
      `SELECT s.role, w.outcome, w.detail FROM wake_state s JOIN wakes w ON w.id = s.outstanding
       ORDER BY s.role`,
    )
    .all() as Row[];
  for (const row of outstanding) {
    wakes.outstanding += 1;
    const outcome = (row.outcome as string | null) ?? "ambiguous";
    if (outcome === "failed" || outcome === "ambiguous") {
      wakes[outcome] += 1;
      exceptions.push({
        detail: (row.detail as string | null) ?? "no outcome recorded",
        kind: outcome === "failed" ? "wake-failed" : "wake-ambiguous",
        role: row.role as string,
      });
    }
  }
  for (const role of pendingWakeRoles(store)) {
    if (wakeState(store, role).outstanding !== null) {
      continue;
    }
    const last = store.db
      .prepare("SELECT outcome, detail FROM wakes WHERE role = ? ORDER BY seq DESC LIMIT 1")
      .get(role) as Row | undefined;
    if (last?.outcome === "guarded") {
      wakes.guarded += 1;
      exceptions.push({
        detail: (last.detail as string | null) ?? "guarded",
        kind: "wake-guarded",
        role,
      });
    }
  }
  const afterSeq = previous === undefined ? 0 : Number(previousSeq(store, previous));
  const runner = store.db
    .prepare(
      `SELECT sum(kind = 'bus.event') AS events, sum(kind = 'bus.complete') AS completes
       FROM events WHERE seq > ?`,
    )
    .get(afterSeq) as Row;
  return {
    counts: {
      byRole: byRole as unknown as Json,
      completes: Number(runner.completes ?? 0),
      open: rows.length,
      runnerEvents: Number(runner.events ?? 0),
      states,
      unconfirmed,
      wakes,
    },
    exceptions,
    open: rows.map((row) => row.id as string),
  };
}

function previousSeq(store: Store, previous: BriefRecord): number {
  const row = store.db
    .prepare("SELECT seq FROM review_briefs WHERE game = ? AND slot = ?")
    .get(previous.game, previous.slot) as Row | undefined;
  return Number(row?.seq ?? 0);
}

function exceptionLine(exception: BriefException): string {
  switch (exception.kind) {
    case "stalled":
      return `- stalled ${exception.id} to ${exception.role} (${exception.state}, open across two slots)`;
    case "unconfirmed":
      return `- unconfirmed ${exception.id} to ${exception.role}: the recipient confirms or closes it`;
    default:
      return `- ${exception.kind} ${exception.role}: ${exception.detail}`;
  }
}

/** The one-page brief: counts, then exceptions while the page has room, then the detail command. */
export function composeBrief(
  game: GameLayout,
  slot: number,
  record: Pick<BriefRecord, "counts" | "exceptions">,
): string {
  const counts = record.counts as Record<string, Json>;
  const states = counts.states as Record<string, number>;
  const wakes = counts.wakes as Record<string, number>;
  const byRole = counts.byRole as Record<string, Record<string, number>>;
  const show = `coordination-kit review show --game ${game.id} --slot ${new Date(slot * 1000).toISOString()}`;
  const head = [
    `Scheduled review, ${game.name}, slot ${new Date(slot * 1000).toISOString()} (stored brief)`,
    `Open messages: ${String(counts.open)} (sent ${states.sent}, delivered ${states.delivered}, ` +
      `retained ${states.retained}); unconfirmed ${String(counts.unconfirmed)}`,
    ...Object.entries(byRole).map(
      ([role, c]) => `  ${role}: sent ${c.sent}, delivered ${c.delivered}, retained ${c.retained}`,
    ),
    `Wakes: ${wakes.outstanding} outstanding, ${wakes.failed} failed, ${wakes.ambiguous} ambiguous, ` +
      `${wakes.guarded} guarded`,
    `Runner since the previous brief: ${String(counts.runnerEvents)} events, ` +
      `${String(counts.completes)} COMPLETE`,
    "Native questions and worker turns are not part of the stored brief: unknown, not clear.",
    `Exceptions: ${record.exceptions.length}`,
  ];
  const tail = [
    `Detail: ${show}`,
    "Close each message with msg done or msg retain; a wake or this brief is not handling.",
  ];
  const lines = [...head];
  const fits = (extra: readonly string[]) => {
    const all = [...lines, ...extra, ...tail];
    return (
      all.length <= BRIEF_MAX_LINES && Buffer.byteLength(all.join("\n"), "utf8") <= BRIEF_MAX_BYTES
    );
  };
  for (const [index, exception] of record.exceptions.entries()) {
    const remaining = record.exceptions.length - index - 1;
    const more = remaining > 0 ? [`- ${remaining} more: ${show}`] : [];
    if (!fits([exceptionLine(exception), ...more])) {
      lines.push(`- ${record.exceptions.length - index} more: ${show}`);
      break;
    }
    lines.push(exceptionLine(exception));
  }
  return [...lines, ...tail].join("\n");
}

/**
 * Store this slot's brief once and wake the recipient. A recorded brief for (game, slot) returns
 * its recorded result. A new episode of stalled messages also stores one `review-stuck` message.
 */
export async function storeReview(
  context: StoreReviewContext,
  game: GameLayout,
  slot: number,
): Promise<ReviewResult> {
  const recipient = routeFor(context.layout, game);
  if (typeof recipient !== "string") {
    return recipient;
  }
  const store = Store.forLayout(
    context.layout,
    context.now === undefined ? {} : { now: context.now },
  );
  try {
    const outcome = store.transaction((): { result: ReviewResult; fresh: boolean } => {
      const recorded = recordedBrief(store, game.id, slot);
      if (recorded !== undefined) {
        return { fresh: false, result: recorded.result };
      }
      const previous = previousBrief(store, game.id, slot);
      const surveyed = survey(store, previous);
      const messageId = derivedId("review-brief", game.id, slot);
      const body = composeBrief(game, slot, surveyed);
      storeNotice(store, { body, fallback: body, id: messageId, to: recipient });
      const stalled = surveyed.exceptions.filter((item) => item.kind === "stalled").length;
      const wasStalled = (previous?.exceptions ?? []).some((item) => item.kind === "stalled");
      if (stalled > 0 && !wasStalled) {
        storeNotice(
          store,
          coordinationNotice(recipient, game, game.name, {
            key: `${recipient}-${slot}`,
            kind: "review-stuck",
            message:
              `Review needs owner reconciliation: ${stalled} messages unhandled across two ` +
              `distinct slots; run coordination-kit review show --game ${game.id} --slot ` +
              `${new Date(slot * 1000).toISOString()} and close or retain each.`,
          }),
        );
      }
      const result: ReviewResult = {
        detail:
          `brief ${messageId} stored for ${recipient}: ${String(surveyed.counts.open)} open, ` +
          `${surveyed.exceptions.length} exceptions`,
        reason: null,
        status: "delivered",
      };
      const record: BriefRecord = {
        ...surveyed,
        game: game.id,
        messageId,
        recipient,
        result,
        slot,
      };
      store.append({
        actor: DELIVERY_KIT_ACTOR,
        key: `review.brief:${game.id}:${slot}`,
        kind: "review.brief",
        payload: record as unknown as JsonObject,
      });
      return { fresh: true, result };
    });
    if (outcome.fresh) {
      const wake = {
        env: context.env,
        layout: context.layout,
        store,
        ...(context.ports === undefined ? {} : { ports: context.ports }),
      };
      // A failed or ambiguous wake waits for this review before it is attempted again.
      for (const role of pendingWakeRoles(store)) {
        const outstanding = wakeState(store, role).outstanding;
        const row =
          outstanding === null
            ? undefined
            : (store.db.prepare("SELECT outcome FROM wakes WHERE id = ?").get(outstanding) as
                Row | undefined);
        if (outstanding !== null && row?.outcome !== "accepted") {
          rearmWake(store, DELIVERY_KIT_ACTOR, role, `review ${game.id} ${slot}`);
        }
      }
      for (const role of [recipient, ...pendingWakeRoles(store).filter((r) => r !== recipient)]) {
        // eslint-disable-next-line no-await-in-loop
        await wakeRecipient(wake, role);
      }
    }
    return outcome.result;
  } finally {
    store.close();
  }
}

/** The recorded brief for a slot, or the latest one (of a game, or of any game). */
export function showBrief(
  layout: Layout,
  selection: { readonly game?: string; readonly slot?: number },
): BriefRecord & { readonly body: string; readonly at: string } {
  const store = Store.forLayout(layout);
  try {
    const row = store.db
      .prepare(
        `SELECT e.payload, e.at, m.body FROM review_briefs b JOIN events e ON e.seq = b.seq
         LEFT JOIN messages m ON m.id = b.message_id
         WHERE (? IS NULL OR b.game = ?) AND (? IS NULL OR b.slot = ?)
         ORDER BY b.slot DESC, b.seq DESC LIMIT 1`,
      )
      .get(
        selection.game ?? null,
        selection.game ?? null,
        selection.slot ?? null,
        selection.slot ?? null,
      ) as Row | undefined;
    if (row === undefined) {
      throw new StoreError("brief-missing");
    }
    return {
      ...(JSON.parse(row.payload as string) as BriefRecord),
      at: row.at as string,
      body: (row.body as string | null) ?? "",
    };
  } finally {
    store.close();
  }
}
