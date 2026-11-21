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
import { clean, DELIVERY_KIT_ACTOR, derivedId, storeNotice } from "../store/notices.ts";
import { type Json, type JsonObject, type Retention, StoreError } from "../store/types.ts";
import {
  pendingWakeRoles,
  rearmWake,
  type WakePorts,
  wakeRecipient,
  wakeState,
} from "../store/wake.ts";
import type { ReviewResult } from "./deliver.ts";
import { coordinationNotice } from "./emit.ts";
import { type RecordedDecisions, recordedDecisions } from "./recordedDecisions.ts";
import { type NativeCollect, type NativeSurvey, surveyNative } from "./storeNative.ts";

export const BRIEF_MAX_LINES = 60;
export const BRIEF_MAX_BYTES = 4096;
/** An accepted Claude wake still unpulled after this long is written again at the next review. */
export const STALE_WAKE_MS = 30 * 60 * 1000;

type Row = Record<string, SQLInputValue>;

export interface StoreReviewContext {
  readonly layout: Layout;
  readonly env: NodeJS.ProcessEnv;
  readonly ports?: WakePorts;
  readonly now?: () => string;
  /** Test hook: replaces the Codex control connection and the legacy collectors. */
  readonly collect?: NativeCollect;
}

interface RouteTarget {
  readonly recipient: string;
}

/** The route recipient and members for this game's slot, or the typed result that ends it. */
function routeFor(layout: Layout, game: GameLayout): RouteTarget | ReviewResult {
  let recipient: string;
  let targets: readonly string[];
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
    targets = route.targets;
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
    const registry = readRegistry(layout);
    for (const target of targets) {
      resolveRole(registry, target);
    }
    return { recipient: resolveRole(registry, recipient) };
  } catch {
    return {
      detail: "the review recipient is not a registered role",
      reason: "recipient-unavailable",
      status: "deferred",
    };
  }
}

export interface BriefException {
  readonly kind:
    | "store-question-pending"
    | "question-pending"
    | "question-unknown"
    | "worker-failed"
    | "worker-unknown"
    | "stalled"
    | "retention-overdue"
    | "unconfirmed"
    | "wake-failed"
    | "wake-ambiguous"
    | "wake-guarded";
  readonly role: string;
  readonly id?: string;
  readonly state?: string;
  readonly detail?: string;
  readonly retention?: Retention;
  /** A pending question's title, at most 80 characters; left out of a secret-shaped fallback. */
  readonly title?: string;
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
  /** Store-recorded questions and decisions, with no claim about native visibility. */
  readonly decisions: RecordedDecisions;
  /** The native question and child health checks as this slot read them. */
  readonly native: NativeSurvey;
  /** Worker failures any brief of this game has reported, so each is reminded once. */
  readonly reportedWorkerFailures: readonly string[];
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

/**
 * The native exceptions first, so they survive the page cap: each owner-attested pending Codex
 * question, each Codex role whose question state is unreadable, each worker failure no earlier
 * brief reported, and each worker parent whose child health is unreadable.
 */
function nativeExceptions(
  native: NativeSurvey,
  previous: BriefRecord | undefined,
): { exceptions: BriefException[]; reported: string[]; counts: JsonObject } {
  const exceptions: BriefException[] = [];
  const reported = new Set(previous?.reportedWorkerFailures ?? []);
  const questions = { clear: 0, historyComplete: 0, pending: 0, unknown: 0, visibilityUnknown: 0 };
  const workers = { failed: 0, ok: 0, unknown: 0 };
  const nonActionable = new Set(["recipient_held", "native_harness_unsupported"]);
  for (const question of native.questions) {
    questions[question.status] += 1;
    questions.visibilityUnknown += Number(question.visibility === "unknown");
    questions.historyComplete += Number(question.history.status === "complete");
    for (const pending of question.pending) {
      exceptions.push({
        detail: `turn ${pending.turn} item ${pending.item}, question ${pending.index}; confirm in its conversation`,
        kind: "question-pending",
        role: question.role,
        ...(pending.title === null ? {} : { title: pending.title }),
      });
    }
    if (question.status === "unknown" && !nonActionable.has(question.reason ?? "")) {
      exceptions.push({
        detail: question.reason ?? "unavailable",
        kind: "question-unknown",
        role: question.role,
      });
    }
  }
  for (const worker of native.workers) {
    workers[worker.status] += 1;
    workers.failed += worker.failures.length;
    for (const [child, turn, code] of worker.failures) {
      const key = [worker.role, child, turn, code].join(" ");
      if (!reported.has(key)) {
        reported.add(key);
        exceptions.push({
          detail: `child ${child} turn ${turn} failed (${code}); the parent decides reassignment`,
          kind: "worker-failed",
          role: worker.role,
        });
      }
    }
    if (worker.status === "unknown" && !nonActionable.has(worker.reason ?? "")) {
      exceptions.push({
        detail: worker.reason ?? "unavailable",
        kind: "worker-unknown",
        role: worker.role,
      });
    }
  }
  return {
    counts: { claudeRoles: native.claudeRoles.length, questions, workers },
    exceptions,
    reported: [...reported].sort(),
  };
}

const NEXT_REVIEW = /^next scheduled review$/i;
const INSTANT =
  /^(?:next scheduled review,\s*)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))$/i;

function retentionDeadline(retention: Retention): number | null {
  const instant = INSTANT.exec(retention.nextBoundary.trim())?.[1];
  if (instant === undefined) {
    return null;
  }
  const parsed = Date.parse(instant);
  const date = instant.slice(0, 10);
  return Number.isFinite(parsed) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
    ? parsed
    : null;
}

/** Unqualified text describes an owner action or dependency, so only a declared time can expire. */
function retentionDue(slot: number, retention: Retention): boolean {
  const slotMs = slot * 1000;
  if (!(Date.parse(retention.at) < slotMs)) {
    return false;
  }
  const deadline = retentionDeadline(retention);
  return deadline === null ? NEXT_REVIEW.test(retention.nextBoundary.trim()) : deadline <= slotMs;
}

function retentionEpisode(exception: BriefException): string {
  const retention = exception.retention!;
  return JSON.stringify([exception.id, retentionDeadline(retention) ?? retention.at]);
}

/** Counts and exceptions from the store as it is now; the previous brief ages open messages. */
function survey(
  store: Store,
  previous: BriefRecord | undefined,
  native: NativeSurvey,
  slot: number,
): Omit<BriefRecord, "game" | "slot" | "recipient" | "messageId" | "result"> {
  const rows = store.db
    .prepare(
      `SELECT id, to_role, state, unconfirmed, retention FROM messages
       WHERE state IN ('sent', 'delivered', 'retained') ORDER BY to_role, sent_seq`,
    )
    .all() as Row[];
  const before = new Set(previous?.open ?? []);
  const byRole: Record<string, Record<string, number>> = {};
  const states: Record<string, number> = { delivered: 0, retained: 0, sent: 0 };
  const checked = nativeExceptions(native, previous);
  const decisions = recordedDecisions(store);
  const exceptions: BriefException[] = [
    ...decisions.pending.map(({ id, role }): BriefException => ({
      id,
      kind: "store-question-pending",
      role,
    })),
    ...checked.exceptions,
  ];
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
    } else if (before.has(id)) {
      if (state !== "retained") {
        exceptions.push({ id, kind: "stalled", role, state });
      } else if (typeof row.retention === "string") {
        const retention = JSON.parse(row.retention) as Retention;
        if (retentionDue(slot, retention)) {
          exceptions.push({ id, kind: "retention-overdue", retention, role, state });
        }
      }
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
      decisions: {
        pending: decisions.pending.length,
        recorded: decisions.recorded.reduce((sum, decision) => sum + decision.count, 0),
      },
      native: checked.counts,
      open: rows.length,
      runnerEvents: Number(runner.events ?? 0),
      states,
      unconfirmed,
      wakes,
    },
    decisions,
    exceptions,
    native,
    open: rows.map((row) => row.id as string),
    reportedWorkerFailures: checked.reported,
  };
}

function previousSeq(store: Store, previous: BriefRecord): number {
  const row = store.db
    .prepare("SELECT seq FROM review_briefs WHERE game = ? AND slot = ?")
    .get(previous.game, previous.slot) as Row | undefined;
  return Number(row?.seq ?? 0);
}

function exceptionLine(exception: BriefException, titles: boolean): string {
  switch (exception.kind) {
    case "store-question-pending":
      return `- store-question-pending ${exception.role}: ${exception.id}; verify in its conversation`;
    case "question-pending":
      return (
        `- question-pending ${exception.role}: ` +
        `${titles && exception.title !== undefined ? `"${exception.title}", ` : ""}${exception.detail}`
      );
    case "stalled":
      return `- stalled ${exception.id} to ${exception.role} (${exception.state}, open across two slots)`;
    case "retention-overdue": {
      const retention = exception.retention!;
      const details = titles
        ? `; ${clean(retention.reason)}; due ${clean(retention.nextBoundary)}`
        : "";
      return (
        `- retention-overdue ${exception.id} to ${exception.role} (owner ${retention.owner})` +
        `${details}; recipient reconciles the original with its owner`
      );
    }
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
  options: { readonly titles?: boolean } = {},
): string {
  const titles = options.titles !== false;
  const counts = record.counts as Record<string, Json>;
  const native = counts.native as {
    claudeRoles: number;
    questions: Record<string, number>;
    workers: Record<string, number>;
  };
  const states = counts.states as Record<string, number>;
  const wakes = counts.wakes as Record<string, number>;
  const decisions = counts.decisions as Record<string, number>;
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
    `Store decisions: ${decisions.recorded} recorded, ${decisions.pending} pending questions`,
    `Native prompt visibility: ${native.questions.visibilityUnknown} unknown; history: ` +
      `${native.questions.historyComplete} complete, ${native.questions.pending} with pending attestations`,
    `Worker parents: ${native.workers.ok} read, ${native.workers.unknown} unknown, ` +
      `${native.workers.failed} failed children`,
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
    if (!fits([exceptionLine(exception, titles), ...more])) {
      lines.push(`- ${record.exceptions.length - index} more: ${show}`);
      break;
    }
    lines.push(exceptionLine(exception, titles));
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
  const route = routeFor(context.layout, game);
  if (!("recipient" in route)) {
    return route;
  }
  const { recipient } = route;
  const store = Store.forLayout(
    context.layout,
    context.now === undefined ? {} : { now: context.now },
  );
  try {
    const earlier = recordedBrief(store, game.id, slot);
    if (earlier !== undefined) {
      return earlier.result;
    }
    // The native checks run before the transaction: no native call runs inside one.
    const native = await surveyNative(
      {
        env: context.env,
        layout: context.layout,
        ...(context.collect === undefined ? {} : { collect: context.collect }),
        ...(context.ports?.connect === undefined ? {} : { connect: context.ports.connect }),
      },
      slot,
    );
    const outcome = store.transaction((): { result: ReviewResult; fresh: boolean } => {
      const recorded = recordedBrief(store, game.id, slot);
      if (recorded !== undefined) {
        return { fresh: false, result: recorded.result };
      }
      const previous = previousBrief(store, game.id, slot);
      const surveyed = survey(store, previous, native, slot);
      const messageId = derivedId("review-brief", game.id, slot);
      storeNotice(store, {
        body: composeBrief(game, slot, surveyed),
        fallback: composeBrief(game, slot, surveyed, { titles: false }),
        id: messageId,
        to: recipient,
      });
      const priorExceptions = previous?.exceptions ?? [];
      const stalled = priorExceptions.some((item) => item.kind === "stalled")
        ? 0
        : surveyed.exceptions.filter((item) => item.kind === "stalled").length;
      const priorRetentions = new Set(
        priorExceptions.filter((item) => item.kind === "retention-overdue").map(retentionEpisode),
      );
      const overdue = surveyed.exceptions.filter(
        (item) => item.kind === "retention-overdue" && !priorRetentions.has(retentionEpisode(item)),
      ).length;
      if (stalled > 0 || overdue > 0) {
        const summary = [
          ...(stalled > 0 ? [`${stalled} messages unhandled across two distinct slots`] : []),
          ...(overdue > 0 ? [`${overdue} retained messages with a passed review boundary`] : []),
        ].join(", ");
        storeNotice(
          store,
          coordinationNotice(recipient, game, game.name, {
            key: `${recipient}-${slot}`,
            kind: "review-stuck",
            message:
              `Review needs owner reconciliation: ${summary}; run coordination-kit review show ` +
              `--game ${game.id} --slot ${new Date(slot * 1000).toISOString()} ` +
              "and reconcile each original with its recipient.",
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
      // A failed or ambiguous wake waits for this review before it is attempted again. So does an
      // accepted Claude wake the recipient has not pulled for STALE_WAKE_MS: a channel that
      // restarted after the wake file was written may never have announced it. A Codex queue
      // item persists in the recipient's queue, so an accepted one is not repeated.
      const staleBefore = Date.parse(context.now?.() ?? new Date().toISOString()) - STALE_WAKE_MS;
      for (const role of pendingWakeRoles(store)) {
        const outstanding = wakeState(store, role).outstanding;
        const row =
          outstanding === null
            ? undefined
            : (store.db
                .prepare("SELECT outcome, harness, at FROM wakes WHERE id = ?")
                .get(outstanding) as Row | undefined);
        const unpulled =
          row?.outcome === "accepted" &&
          row.harness === "claude" &&
          Date.parse(String(row.at)) <= staleBefore;
        if (outstanding !== null && (row?.outcome !== "accepted" || unpulled)) {
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
