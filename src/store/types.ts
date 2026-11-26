// Shared store types and errors.
import type { DatabaseSync } from "node:sqlite";

export const STORE_SCHEMA = 1;
/** A registry role key: a shared role, or a game and its role joined by `/`. */
export const ROLE = /^[a-z0-9][a-z0-9-]{0,63}(?:\/[a-z0-9][a-z0-9-]{0,63})?$/;
/** The `prev_hash` of the first event. */
export const GENESIS = "0".repeat(64);

export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

export class StoreError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? `store: ${code}` : `store: ${code}: ${detail}`);
    this.code = code;
    this.name = "StoreError";
  }
}

export function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new StoreError(code);
  }
}

/**
 * Who wrote an event. `role` and `nativeId` come from the registry fence for CLI writers, or are
 * null for import and maintenance. `worker` is the caller's unverified attribution.
 */
export interface Actor {
  readonly role: string | null;
  readonly nativeId: string | null;
  readonly worker?: string;
}

export interface EventInput {
  /** Unique per command; an existing key makes the append a no-op. */
  readonly key: string;
  /** Dotted lower-case kind such as `msg.sent`. */
  readonly kind: string;
  readonly actor: Actor;
  readonly payload: JsonObject;
  /** Defaults to the store clock. */
  readonly at?: string;
}

/**
 * A table set derived from the events, updated in the append transaction and rebuilt by
 * `Store.rebuild`: its tables, their DDL and one applier per event kind.
 */
export interface Projection {
  readonly tables: readonly string[];
  readonly ddl: string;
  readonly apply: Readonly<Record<string, (db: DatabaseSync, event: StoredEvent) => void>>;
}

export interface StoredEvent {
  readonly seq: number;
  readonly key: string;
  readonly kind: string;
  readonly actor: Actor;
  readonly at: string;
  readonly payload: JsonObject;
  readonly prevHash: string;
  readonly hash: string;
}

export type MessageState = "sent" | "delivered" | "handled" | "retained" | "superseded";
export const MESSAGE_STATES: readonly MessageState[] = [
  "sent",
  "delivered",
  "handled",
  "retained",
  "superseded",
];
export type MessageIntent = "queue" | "unblock";
/** Sender shown for local queue traffic without a binding, outside the registry role grammar. */
export const UNBOUND_MESSAGE_SENDER = "[unbound]";

export interface MessageLink {
  readonly kind: string;
  readonly ref: string;
}

export interface Retention {
  readonly owner: string;
  readonly reason: string;
  readonly nextBoundary: string;
  readonly at: string;
}

/** Legacy provenance of an imported message. */
export interface LegacyOrigin {
  readonly state: string;
  readonly payloadHash: string;
  readonly source: string;
}

/** A message as every read prints it. The body appears only on request. */
export interface MessageView {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly intent: MessageIntent;
  readonly state: MessageState;
  /** Imported from an uncertain legacy delivery; the recipient alone can say whether it acted. */
  readonly unconfirmed: boolean;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly closedAt: string | null;
  readonly bodySha256: string;
  readonly links: readonly MessageLink[];
  readonly worker: string | null;
  readonly work: string | null;
  readonly supersededBy: string | null;
  readonly evidence: readonly string[];
  readonly retention: Retention | null;
  readonly legacy: LegacyOrigin | null;
  readonly body?: string;
  /** A requested body was expired under an independently qualified checkpoint. */
  readonly bodyExpired?: true;
}

export type WakeOutcome = "accepted" | "guarded" | "failed" | "ambiguous";

export interface WorkRef {
  readonly repository: string;
  readonly id: string;
}

export interface NativeQuestionIdentity {
  readonly turn: string;
  readonly item: string;
  readonly index: number;
}

export interface CodexQuestionInput {
  readonly thread: string;
  readonly dependsOn: readonly WorkRef[];
}

/** Safe links to an exact blocker, or the wake event carrying unresolved evidence. */
export interface WakeBlocker {
  readonly kind: "question" | "hold" | "policy-hold" | "registry" | "wake" | "native-question";
  readonly id: string;
  readonly owner: string;
  readonly native?: { readonly turnId: string; readonly itemId: string };
}

export interface WakeGuard {
  readonly status: "clear" | "blocked";
  readonly reason?: string;
  readonly blocker?: WakeBlocker;
}

export interface MessageWakeView {
  readonly outcome: WakeOutcome | "coalesced" | "unknown";
  readonly wake: string | null;
  readonly reason: string | null;
  readonly blocker: WakeBlocker | null;
  readonly nextAction:
    | "collect-at-safe-boundary"
    | "reconcile-without-resending"
    | "reconcile-original"
    | "follow-retention-boundary"
    | "none";
}

export interface UnreadMessage {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly wake: MessageWakeView;
}
