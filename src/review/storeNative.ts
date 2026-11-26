// Read bounded, recipient-scoped native evidence for the scheduled review.
import { performance } from "node:perf_hooks";

import { channelResolution } from "../adapters/claude/channelStatus.ts";
import { collectAll, unavailableCollected } from "../adapters/codex/collect.ts";
import { connectControl, type RpcClient } from "../adapters/codex/rpc.ts";
import {
  decisionDirectory,
  type DecisionMarkerDiagnostic,
  type DecisionMarkerInspection,
  inspectDecisionMarker,
} from "../adapters/shared/decisions.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import type { Collected, CollectRequest } from "../adapters/types.ts";
import type { Clock } from "../core/clock.ts";
import { isCanonicalUuid } from "../core/ids.ts";
import type { Layout } from "../core/layout.ts";
import { isRecord } from "../core/pyjson.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Harness, RoleRecord } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { secretShape } from "../store/secrets.ts";

type Json = Record<string, unknown>;

function rec(value: unknown): Json {
  return isRecord(value) ? value : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** An owner-attested pending question on its owner's latest turn. */
function pendingProven(owner: string, question: Json): boolean {
  const proofs = question.proof_refs;
  return (
    question.state === "pending" &&
    identifier(question.turn_id) &&
    identifier(question.item_id) &&
    Number.isInteger(question.question_index) &&
    Number(question.question_index) >= 0 &&
    question.proof_complete === true &&
    question.proof_scope === "latest_turn" &&
    Array.isArray(proofs) &&
    (proofs as unknown[]).some(
      (proof) =>
        isRecord(proof) &&
        proof.kind === "owner_pending_attestation" &&
        proof.recipient === owner &&
        proof.question_turn_id === question.turn_id &&
        proof.question_item_id === question.item_id &&
        proof.question_index === question.question_index,
    )
  );
}

/** The review's connection budget; the collectors reserve five seconds of it. */
const CONNECT_MS = 25_000;
const TITLE_CHARS = 80;

type QuestionStatus = "pending" | "clear" | "unknown";

export interface NativeQuestion {
  readonly role: string;
  readonly status: QuestionStatus;
  readonly visibility: "unknown";
  readonly visibilityReason: string;
  readonly decisionRecord: "clear" | "pending" | "unknown";
  /** Marker structure only. Native question state and owner clearance are independent. */
  readonly decisionMarker: DecisionMarkerDiagnostic | null;
  readonly history: {
    readonly status: "complete" | "partial" | "unavailable";
    readonly answered: number;
    readonly unresolved: number;
    readonly reason: string | null;
  };
  /** Owner-attested pending questions on the owner's latest turn. */
  readonly pending: readonly {
    readonly turn: string;
    readonly item: string;
    readonly index: number;
    readonly title: string | null;
  }[];
  readonly reason: string | null;
}

export interface NativeWorker {
  readonly role: string;
  readonly status: "ok" | "unknown";
  /** Verified coverage for this slot. Older stored briefs omit it. */
  readonly coverage?: "complete" | "partial" | "unavailable";
  /** Verified latest failed child turns: [child, turn, error code]. */
  readonly failures: readonly (readonly [string, string, string])[];
  readonly unavailableChildren: readonly { readonly id: string; readonly reason: string }[];
  /** Exact lineage observed by the native collector. Caller binding requires separate proof. */
  readonly lineage: {
    readonly parentNativeId: string;
    readonly workerNativeIds: readonly string[];
  } | null;
  readonly reason: string | null;
}

/**
 * A registered, active Claude role's channel status file against its current binding:
 * `current`, `stale` (it names another conversation), `missing` or `unreadable`.
 */
export interface NativeChannel {
  readonly role: string;
  readonly status: "current" | "stale" | "missing" | "unreadable";
  /** The role's current Claude binding. */
  readonly binding: string | null;
  /** The binding the status file names, when it was read. */
  readonly conversation: string | null;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly version: string | null;
}

export interface NativeSurvey {
  readonly registryRevision: number;
  readonly questions: readonly NativeQuestion[];
  readonly workers: readonly NativeWorker[];
  /** Registered Claude roles have no native question or child health collector. */
  readonly claudeRoles: readonly string[];
  /** Each active Claude role's channel status; briefs recorded before 6.4.0 omit it. */
  readonly channels?: readonly NativeChannel[];
}

/** The collectors' entry point; the default connects and runs `collectAll`. */
export type NativeCollect = (request: CollectRequest) => Promise<Collected>;

interface NativeContext {
  readonly clock: Clock;
  readonly layout: Layout;
  readonly env: NodeJS.ProcessEnv;
  /** The Codex control connection, as for wakes; defaults to the resolved control socket. */
  readonly connect?: () => Promise<RpcClient>;
  /** Test hook: replaces the connection and collectors. */
  readonly collect?: NativeCollect;
}

function defaultCollect(context: NativeContext): NativeCollect {
  return async (request) => {
    const deadline = performance.now() + CONNECT_MS;
    let client: RpcClient;
    try {
      client = await (
        context.connect ??
        (() => connectControl(deadline, resolveCodexControlSocket({ env: context.env }).path))
      )();
    } catch {
      return unavailableCollected("control_unavailable", request);
    }
    try {
      return await collectAll(context.clock, client, deadline, request);
    } catch {
      return unavailableCollected("collector_unavailable", request);
    } finally {
      client.close();
    }
  };
}

function active(record: RoleRecord): boolean {
  return record.ownership === "active" && record.phase !== "held" && record.phase !== "source-held";
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function reasonOf(value: Json, excluded?: string): string {
  const diagnostic = list(value.diagnostics).find((item) => identifier(item) && item !== excluded);
  return String(diagnostic ?? value.reason_code ?? value.status ?? "unavailable");
}

function answeredProven(recipient: string, question: Json): boolean {
  return (
    question.state === "answered" &&
    identifier(question.turn_id) &&
    identifier(question.item_id) &&
    list(question.proof_refs).some(
      (proof) =>
        isRecord(proof) &&
        proof.recipient === recipient &&
        proof.question_turn_id === question.turn_id &&
        proof.question_item_id === question.item_id &&
        identifier(proof.answer_turn_id) &&
        identifier(proof.answer_item_id),
    )
  );
}

export const NO_PROMPT_VISIBILITY = "exact_unresolved_request_unavailable";

function publicDecisionMarker(marker: DecisionMarkerInspection): DecisionMarkerDiagnostic {
  if (marker.state === "invalid") {
    const { fields, reason, state } = marker;
    return fields === undefined ? { reason, state } : { fields, reason, state };
  }
  return { state: marker.state };
}

function questionStatus(
  role: string,
  conversation: string | null,
  marker: DecisionMarkerInspection | null,
  unavailable: string | null,
  value: unknown,
): NativeQuestion {
  const state = rec(value);
  const questions = list(state.questions).map(rec);
  const pending =
    conversation === null
      ? []
      : questions.filter((question) => pendingProven(conversation, question));
  const answered =
    conversation === null
      ? 0
      : questions.filter((question) => answeredProven(conversation, question)).length;
  const status = pending.length === 0 ? "unknown" : "pending";
  const history =
    state.status === "complete" && state.complete === true
      ? "complete"
      : state.status === "partial"
        ? "partial"
        : "unavailable";
  const visibilityReason =
    unavailable ?? (history === "unavailable" ? reasonOf(state) : NO_PROMPT_VISIBILITY);
  const decision = marker?.state;
  return {
    decisionMarker: marker === null ? null : publicDecisionMarker(marker),
    decisionRecord: decision === "clear" || decision === "pending" ? decision : "unknown",
    history: {
      answered,
      reason:
        history === "complete" ? null : (unavailable ?? reasonOf(state, NO_PROMPT_VISIBILITY)),
      status: history,
      unresolved: questions.length - answered,
    },
    pending: pending.map((question) => ({
      index: Number(question.question_index),
      item: String(question.item_id),
      title:
        typeof question.title === "string" && secretShape(question.title) === null
          ? Array.from(question.title).slice(0, TITLE_CHARS).join("")
          : null,
      turn: String(question.turn_id),
    })),
    reason: status === "pending" ? null : visibilityReason,
    role,
    status,
    visibility: "unknown",
    visibilityReason,
  };
}

function workerStatus(
  role: string,
  conversation: string | null,
  unavailable: string | null,
  value: unknown,
): NativeWorker {
  const health = rec(value);
  const children = list(health.children).map(rec);
  const verified =
    conversation === null
      ? []
      : children.filter(
          (child) => child.parent_id === conversation && child.lineage_verified === true,
        );
  const failures = new Map<string, readonly [string, string, string]>();
  const unavailableChildren: { id: string; reason: string }[] = [];
  for (const child of verified) {
    if (!isCanonicalUuid(child.child_id)) {
      continue;
    }
    if (child.complete !== true) {
      unavailableChildren.push({ id: child.child_id, reason: reasonOf(child) });
    }
    if (
      child.requires_parent_action === true &&
      child.complete === true &&
      child.turn_status === "failed" &&
      isCanonicalUuid(child.turn_id) &&
      identifier(child.error_code)
    ) {
      const failure = [child.child_id, child.turn_id, child.error_code] as const;
      failures.set(JSON.stringify(failure), failure);
    }
  }
  const readable =
    health.status === "complete" &&
    health.complete === true &&
    health.schema_status === "available" &&
    Array.isArray(health.children) &&
    children.length === verified.length &&
    verified.every((child) => isCanonicalUuid(child.child_id) && child.complete === true);
  const lineage =
    unavailable === null && isCanonicalUuid(conversation) && health.provenance === "native_protocol"
      ? {
          parentNativeId: conversation,
          workerNativeIds: [
            ...new Set(
              verified
                .filter(
                  (child) =>
                    child.provenance === "native_protocol" &&
                    child.status === "complete" &&
                    child.complete === true &&
                    isCanonicalUuid(child.child_id) &&
                    child.child_id !== conversation,
                )
                .map((child) => child.child_id as string),
            ),
          ].sort(),
        }
      : null;
  return {
    coverage: readable
      ? "complete"
      : (lineage?.workerNativeIds.length ?? 0) > 0
        ? "partial"
        : "unavailable",
    failures: [...failures.keys()].sort().map((key) => failures.get(key)!),
    lineage,
    reason: readable
      ? null
      : (unavailable ??
        (health.status === "complete" ? "worker_coverage_unverified" : reasonOf(health))),
    role,
    status: readable ? "ok" : "unknown",
    unavailableChildren,
  };
}

function unavailableRecipient(
  bindingCounts: ReadonlyMap<string, number>,
  record: RoleRecord,
  harness: Harness,
  conversation: string | null,
): string | null {
  if (!active(record)) {
    return "recipient_held";
  }
  if (conversation === null) {
    return "recipient_unbound";
  }
  if (harness !== "codex") {
    return "native_harness_unsupported";
  }
  if (!isCanonicalUuid(conversation)) {
    return "recipient_binding_invalid";
  }
  return bindingCounts.get(conversation) === 1 ? null : "recipient_binding_ambiguous";
}

/** One role's channel status file; a file or directory it cannot read is `unreadable`. */
function channelStatus(layout: Layout, role: string, binding: string | null): NativeChannel {
  const resolution = channelResolution(layout, role, binding);
  const status = "status" in resolution ? resolution.status : null;
  return {
    binding,
    conversation: status?.conversation ?? null,
    pid: status?.pid ?? null,
    role,
    startedAt: status?.startedAt ?? null,
    status: resolution.state,
    version: status?.version ?? null,
  };
}

/** Read every registered role and its exact native children outside the store transaction. */
export async function surveyNative(context: NativeContext, slot: number): Promise<NativeSurvey> {
  const { layout } = context;
  const registry = readRegistry(layout);
  const roles = Object.keys(registry.roles)
    .sort()
    .map((role) => ({
      conversation: resolveConversation(registry, role),
      harness: resolveHarness(registry, role),
      record: registry.roles[role]!,
      role,
    }));
  const bindingCounts = new Map<string, number>();
  for (const { conversation, harness } of roles) {
    if (harness === "codex" && conversation !== null) {
      bindingCounts.set(conversation, (bindingCounts.get(conversation) ?? 0) + 1);
    }
  }
  const targets = roles.map(({ conversation, harness, record, role }) => {
    const reason = unavailableRecipient(bindingCounts, record, harness, conversation);
    const recipient = reason === null ? conversation : null;
    const directory = recipient === null ? null : decisionDirectory(layout, role);
    const marker =
      directory === null || recipient === null ? null : inspectDecisionMarker(directory, recipient);
    return { marker, reason, recipient, role };
  });

  const recipients = targets.flatMap(({ recipient }) => (recipient === null ? [] : [recipient]));
  const request: CollectRequest = {
    decisionRecords: Object.fromEntries(
      targets.flatMap(({ marker, recipient }) =>
        recipient === null ? [] : [[recipient, marker?.record ?? null]],
      ),
    ),
    parents: recipients,
    recipients,
    slot,
  };
  const collected =
    recipients.length === 0
      ? unavailableCollected("recipient_unavailable", request)
      : await (context.collect ?? defaultCollect(context))(request);
  return {
    channels: roles
      .filter(({ harness, record }) => harness === "claude" && active(record))
      .map(({ conversation, role }) => channelStatus(layout, role, conversation)),
    claudeRoles: roles.filter(({ harness }) => harness === "claude").map(({ role }) => role),
    questions: targets.map(({ marker, reason, recipient, role }) =>
      questionStatus(
        role,
        recipient,
        marker,
        reason,
        recipient === null ? undefined : collected.question_state[recipient],
      ),
    ),
    registryRevision: registry.revision,
    workers: targets.map(({ reason, recipient, role }) =>
      workerStatus(
        role,
        recipient,
        reason,
        recipient === null ? undefined : collected.worker_health[recipient],
      ),
    ),
  };
}
