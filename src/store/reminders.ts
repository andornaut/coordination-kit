import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";

import {
  decisionDirectory,
  type DecisionRecord,
  decisionRecord,
} from "../adapters/shared/decisions.ts";
import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import type { Layout } from "../layout.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Registry } from "../registry/schema.ts";
import type { Store } from "./db.ts";
import { MESSAGE_ID } from "./messages.ts";
import { safeWakeReason, unreadMessages } from "./messageWake.ts";
import { pendingNotices } from "./noticesInFlight.ts";
import type { Projection } from "./projections.ts";
import { questionHoldGuard } from "./questions.ts";
import { type Actor, type JsonObject, StoreError, type UnreadMessage } from "./types.ts";

type Row = Record<string, SQLInputValue>;
const COORDINATOR = "game-coordinator";
export const REMINDER_OUTCOMES = ["submitted", "refused", "uncertain"] as const;
export type ReminderOutcome = (typeof REMINDER_OUTCOMES)[number];
const MAX_REMINDER_ORIGINALS = 50;

export interface ReminderReceipt {
  readonly id: string;
  readonly role: string;
  readonly originals: readonly string[];
  readonly harness: "codex";
  readonly nativeId: string;
  readonly revision: number;
}

export interface ReminderCandidate {
  readonly role: string;
  readonly originals: readonly string[];
  readonly deferredOriginals: readonly string[];
}

type OriginalRef = { readonly id: string; readonly wake: string };

type EligibleOriginal = { readonly original: UnreadMessage; readonly wake: string };

interface ReminderBatch {
  readonly role: string;
  readonly originals: readonly EligibleOriginal[];
  readonly deferredOriginals: readonly EligibleOriginal[];
}

interface Binding {
  readonly harness: "codex";
  readonly nativeId: string;
  readonly revision: number;
}

export interface ReminderScope {
  readonly layout: Layout;
  readonly registry: Registry;
}

const DDL = `
CREATE TABLE IF NOT EXISTS reminder_claims (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  claimed_seq INTEGER NOT NULL,
  outcome TEXT,
  reason TEXT,
  settled_seq INTEGER
);
CREATE TABLE IF NOT EXISTS reminder_originals (
  claim_id TEXT NOT NULL,
  original_id TEXT NOT NULL,
  wake_id TEXT NOT NULL,
  PRIMARY KEY (claim_id, original_id)
);
CREATE INDEX IF NOT EXISTS reminder_by_original ON reminder_originals (original_id, claim_id);
CREATE UNIQUE INDEX IF NOT EXISTS reminder_one_open_per_role ON reminder_claims (role)
  WHERE outcome IS NULL;
`;

export const REMINDER_PROJECTION: Projection = {
  apply: {
    "reminder.claimed": (db, event) => {
      const { harness, id, nativeId, originals, revision, role } = event.payload;
      db.prepare(
        `INSERT INTO reminder_claims (id, role, harness, native_id, revision, claimed_seq)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id as string,
        role as string,
        harness as string,
        nativeId as string,
        revision as number,
        event.seq,
      );
      const insert = db.prepare(
        "INSERT INTO reminder_originals (claim_id, original_id, wake_id) VALUES (?, ?, ?)",
      );
      for (const original of originals as readonly JsonObject[]) {
        insert.run(id as string, original.id as string, original.wake as string);
      }
    },
    "reminder.settled": (db, event) => {
      const { id, outcome, reason } = event.payload;
      db.prepare(
        "UPDATE reminder_claims SET outcome = ?, reason = ?, settled_seq = ? WHERE id = ? AND outcome IS NULL",
      ).run(outcome as string, reason as string, event.seq, id as string);
    },
  },
  ddl: DDL,
  tables: ["reminder_claims", "reminder_originals"],
};

function require(condition: boolean, code: string): asserts condition {
  if (!condition) {
    throw new StoreError(code);
  }
}

export function requireReminderCoordinator(registry: Registry, actor: Actor): void {
  const owner = registry.roles[COORDINATOR];
  require(actor.role === COORDINATOR &&
    actor.worker === undefined &&
    owner?.ownership === "active" &&
    owner.phase !== "held" &&
    owner.phase !== "source-held" &&
    actor.nativeId !== null &&
    actor.nativeId === resolveConversation(registry, COORDINATOR), "not-coordinator");
}

type BindingCheck = Binding | { readonly refusal: string };

/** Undefined means blocked or unreadable. Null is a positively absent marker. */
export function reminderClearance(
  directory: string,
  nativeId: string,
): DecisionRecord | null | undefined {
  if (!isCanonicalUuid(nativeId)) {
    return undefined;
  }
  try {
    if (!lstatSync(join(directory, "decisions", `${nativeId}.json`)).isFile()) {
      return undefined;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return undefined;
  }
  const marker = decisionRecord(directory, nativeId);
  return marker?.state === "clear" ? marker : undefined;
}

function binding(
  store: Store,
  scope: ReminderScope,
  role: string,
  ownNotice?: string,
): BindingCheck {
  const entry = scope.registry.roles[role];
  if (
    role === COORDINATOR ||
    entry?.ownership !== "active" ||
    entry.phase === "held" ||
    entry.phase === "source-held" ||
    resolveHarness(scope.registry, role) !== "codex"
  ) {
    return { refusal: "reminder-role-guarded" };
  }
  const nativeId = resolveConversation(scope.registry, role);
  const directory = decisionDirectory(scope.layout, role);
  if (nativeId === null || questionHoldGuard(store, role, "codex").status !== "clear") {
    return { refusal: "reminder-role-guarded" };
  }
  if (directory === null || reminderClearance(directory, nativeId) === undefined) {
    return { refusal: "reminder-owner-clearance-required" };
  }
  if (pendingNotices(store, { conversation: nativeId, role }).some(({ id }) => id !== ownNotice)) {
    return { refusal: "reminder-notice-outstanding" };
  }
  return { harness: "codex", nativeId, revision: scope.registry.revision };
}

/** Past guard refusals prove non-submission only. The current state needs independent checks. */
const PRE_SUBMIT_GUARDS = new Set([
  "compaction-unproven",
  "decision-clearance",
  "decision-marker-absent",
  "decision-marker-invalid",
  "decision-marker-pending",
  "decision-marker-unreadable",
  "direct-input-not-allowed",
  "input-unavailable",
  "rpc-refusal",
]);

interface ExactWake {
  readonly id: string;
  readonly seq: number;
}

function exactWake(store: Store, target: Binding, original: UnreadMessage): ExactWake | null {
  const { outcome, reason, wake } = original.wake;
  if (
    wake === null ||
    reason === null ||
    (outcome !== "failed" && (outcome !== "guarded" || !PRE_SUBMIT_GUARDS.has(reason)))
  ) {
    return null;
  }
  const row = store.db
    .prepare(
      `SELECT w.seq FROM wakes w JOIN messages m ON m.id = ? AND m.to_role = w.role
     WHERE w.id = ? AND w.harness = ? AND w.conversation = ? AND w.outcome = ?
       AND m.state = 'sent' AND m.unconfirmed = 0`,
    )
    .get(original.id, wake, target.harness, target.nativeId, outcome);
  return row === undefined ? null : { id: wake, seq: Number(row.seq) };
}

function hasLedger(store: Store): boolean {
  return (
    store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reminder_claims'")
      .get() !== undefined
  );
}

function roleHasClaim(store: Store, role: string): boolean {
  return (
    store.db
      .prepare("SELECT 1 FROM reminder_claims WHERE role = ? AND outcome IS NULL")
      .get(role) !== undefined
  );
}

function claimOriginals(store: Store, id: string): readonly OriginalRef[] {
  // The event preserves the exact claim order. The deduplication index is unordered.
  const originals = store.eventByKey(`reminder.claimed:${id}`)?.payload.originals;
  require(Array.isArray(originals) && originals.length > 0, "reminder-original-stale");
  return originals as readonly OriginalRef[];
}

/** Identify interrupted claims for reconciliation. The caller never resumes their attempt. */
export function pendingReminders(
  store: Store,
): readonly Pick<ReminderReceipt, "id" | "role" | "originals">[] {
  if (!hasLedger(store)) {
    return [];
  }
  const pending = store.db
    .prepare("SELECT id, role FROM reminder_claims WHERE outcome IS NULL ORDER BY claimed_seq")
    .all() as { id: string; role: string }[];
  return pending.map(({ id, role }) => ({
    id,
    originals: claimOriginals(store, id).map((original) => original.id),
    role,
  }));
}

function canClaim(
  store: Store,
  ledger: boolean,
  latestReview: number,
  id: string,
  wake: ExactWake,
): boolean {
  if (!ledger) {
    return true;
  }
  const row = store.db
    .prepare(
      `SELECT c.outcome, c.settled_seq, o.wake_id
     FROM reminder_originals o JOIN reminder_claims c ON c.id = o.claim_id
     WHERE o.original_id = ? ORDER BY c.claimed_seq DESC LIMIT 1`,
    )
    .get(id);
  return (
    row === undefined ||
    (row.outcome === "refused" &&
      row.wake_id !== wake.id &&
      Number(row.settled_seq) < wake.seq &&
      wake.seq < latestReview)
  );
}

function planReminders(store: Store, scope: ReminderScope, role: string | null): ReminderBatch[] {
  const ledger = hasLedger(store);
  const latestReview = Number(
    store.db.prepare("SELECT max(seq) AS seq FROM review_briefs").get()?.seq ?? 0,
  );
  const bindings = new Map<string, BindingCheck>();
  const candidates = new Map<string, EligibleOriginal[]>();
  for (const original of unreadMessages(store, role)) {
    if (!bindings.has(original.to)) {
      bindings.set(
        original.to,
        ledger && roleHasClaim(store, original.to)
          ? { refusal: "reminder-role-in-flight" }
          : binding(store, scope, original.to),
      );
    }
    const target = bindings.get(original.to);
    const wake =
      target === undefined || "refusal" in target ? null : exactWake(store, target, original);
    if (wake !== null && canClaim(store, ledger, latestReview, original.id, wake)) {
      const list = candidates.get(original.to) ?? [];
      list.push({ original, wake: wake.id });
      candidates.set(original.to, list);
    }
  }
  return [...candidates.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, eligible]) => ({
      deferredOriginals: eligible.slice(MAX_REMINDER_ORIGINALS),
      originals: eligible.slice(0, MAX_REMINDER_ORIGINALS),
      role,
    }));
}

export function listReminders(store: Store, scope: ReminderScope): ReminderCandidate[] {
  return planReminders(store, scope, null).map(({ deferredOriginals, originals, role }) => ({
    deferredOriginals: deferredOriginals.map(({ original }) => original.id),
    originals: originals.map(({ original }) => original.id),
    role,
  }));
}

export function claimReminder(
  store: Store,
  scope: ReminderScope,
  actor: Actor,
  selection: { readonly role: string; readonly originals: readonly string[] },
): ReminderReceipt {
  requireReminderCoordinator(scope.registry, actor);
  const { originals, role } = selection;
  require(originals.length > 0 &&
    new Set(originals).size === originals.length &&
    originals.every((id) => MESSAGE_ID.test(id)), "reminder-invalid-originals");
  return store.transaction(() => {
    require(!roleHasClaim(store, role), "reminder-role-in-flight");
    const target = binding(store, scope, role);
    if ("refusal" in target) {
      throw new StoreError(target.refusal);
    }
    const offered = planReminders(store, scope, role)[0]?.originals ?? [];
    require(originals.every(
      (id, index) => offered[index]?.original.id === id,
    ), "reminder-original-ineligible");
    // Later arrivals can extend a plan without changing the already observed prefix.
    const refs = offered.slice(0, originals.length).map(({ original, wake }) => ({
      id: original.id,
      wake,
    }));
    const id = randomUUID();
    store.append({
      actor,
      key: `reminder.claimed:${id}`,
      kind: "reminder.claimed",
      payload: { ...target, id, originals: refs, role },
    });
    return { ...target, id, originals: refs.map((ref) => ref.id), role };
  });
}

function readClaim(store: Store, id: string): Row {
  require(isCanonicalUuid(id), "reminder-invalid-id");
  const row = hasLedger(store)
    ? (store.db.prepare("SELECT * FROM reminder_claims WHERE id = ?").get(id) as Row | undefined)
    : undefined;
  require(row !== undefined, "reminder-missing");
  return row;
}

export function checkReminder(
  store: Store,
  scope: ReminderScope,
  actor: Actor,
  id: string,
): ReminderReceipt {
  requireReminderCoordinator(scope.registry, actor);
  const row = readClaim(store, id);
  require(row.outcome === null, "reminder-settled");
  const role = row.role as string;
  const target = binding(store, scope, role, id);
  if ("refusal" in target) {
    throw new StoreError(target.refusal);
  }
  require(target.harness === row.harness &&
    target.nativeId === row.native_id &&
    target.revision === row.revision, "reminder-binding-stale");
  const receipts = claimOriginals(store, id);
  const unread = new Map(unreadMessages(store, role).map((original) => [original.id, original]));
  for (const receipt of receipts) {
    const original = unread.get(receipt.id);
    require(original !== undefined &&
      exactWake(store, target, original)?.id === receipt.wake, "reminder-original-stale");
  }
  return { ...target, id, originals: receipts.map((receipt) => receipt.id), role };
}

export function settleReminder(
  store: Store,
  scope: ReminderScope,
  actor: Actor,
  settlement: { readonly id: string; readonly outcome: ReminderOutcome; readonly reason: string },
): { readonly id: string; readonly outcome: ReminderOutcome; readonly reason: string } {
  requireReminderCoordinator(scope.registry, actor);
  const { id, outcome, reason } = settlement;
  require(REMINDER_OUTCOMES.includes(outcome), "reminder-invalid-outcome");
  require(safeWakeReason(reason, "") === reason && reason !== "", "reminder-invalid-reason");
  return store.transaction(() => {
    const row = readClaim(store, id);
    if (row.outcome !== null) {
      require(row.outcome === outcome && row.reason === reason, "reminder-settlement-conflict");
      return settlement;
    }
    store.append({
      actor,
      key: `reminder.settled:${id}`,
      kind: "reminder.settled",
      payload: { id, outcome, reason },
    });
    return settlement;
  });
}
