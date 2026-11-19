// The native checks the stored brief keeps: each Codex route member's question state and each
// Codex worker parent's child health, read through the legacy brief's own collectors
// (`collectAll`: question state, then child health, under its shared 256-call budget and
// deadline) over one control connection. Read-only. A capability that cannot be read is unknown,
// never clear.
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { collectAll, unavailableCollected } from "../adapters/codex/collect.ts";
import { connectControl, type RpcClient } from "../adapters/codex/rpc.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import { isRecord } from "../adapters/shared/pyjson.ts";
import type { Collected, CollectRequest } from "../adapters/types.ts";
import { loadReportsConfig } from "../config.ts";
import type { GameLayout, Layout } from "../layout.ts";
import { resolveConversation, resolveHarness } from "../registry/resolve.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";

type Json = Record<string, unknown>;

function rec(value: unknown): Json {
  return isRecord(value) ? value : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** Verified latest failed child turns as sorted [parent, child, turn, error_code] references. */
function workerFailures(snapshot: Json): unknown[][] {
  const references: unknown[] = [];
  for (const [parent, health] of Object.entries(rec(snapshot.worker_health))) {
    for (const value of list(rec(health).children)) {
      const child = rec(value);
      if (
        child.parent_id === parent &&
        child.lineage_verified === true &&
        child.requires_parent_action === true &&
        child.turn_status === "failed" &&
        ["child_id", "turn_id", "error_code"].every(
          (field) => typeof child[field] === "string" && child[field] !== "",
        )
      ) {
        references.push([parent, child.child_id, child.turn_id, child.error_code]);
      }
    }
  }
  const unique = new Map(references.map((row) => [JSON.stringify(row), row as unknown[]]));
  return [...unique.keys()].sort().map((key) => unique.get(key)!);
}

/** An owner-attested pending question on its owner's latest turn. */
function pendingProven(owner: string, question: Json): boolean {
  const proofs = question.proof_refs;
  return (
    question.state === "pending" &&
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

export type QuestionStatus = "pending" | "clear" | "unknown";

export interface NativeQuestion {
  readonly role: string;
  readonly status: QuestionStatus;
  /** Owner-attested pending questions on the owner's latest turn. */
  readonly pending: readonly {
    readonly turn: string;
    readonly item: string;
    readonly title: string | null;
  }[];
  readonly reason: string | null;
}

export interface NativeWorker {
  readonly role: string;
  readonly status: "ok" | "unknown";
  /** Verified latest failed child turns: [child, turn, error code]. */
  readonly failures: readonly (readonly [string, string, string])[];
  readonly reason: string | null;
}

export interface NativeSurvey {
  readonly questions: readonly NativeQuestion[];
  readonly workers: readonly NativeWorker[];
  /** Claude route members and parents: no native question or child health check exists. */
  readonly claudeRoles: readonly string[];
}

/** The collectors' entry point; the default connects and runs `collectAll`. */
export type NativeCollect = (request: CollectRequest) => Promise<Collected>;

export interface NativeContext {
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
      return await collectAll(client, deadline, request);
    } catch {
      return unavailableCollected("collector_unavailable", request);
    } finally {
      client.close();
    }
  };
}

function active(registry: Registry, role: string): boolean {
  const record = registry.roles[role];
  return (
    record !== undefined &&
    record.ownership === "active" &&
    record.phase !== "held" &&
    record.phase !== "source-held"
  );
}

function reasonOf(value: Record<string, unknown>): string {
  const diagnostics = list(value.diagnostics).filter((item) => typeof item === "string");
  return String(diagnostics[0] ?? value.reason_code ?? value.status ?? "unavailable");
}

function questionStatus(role: string, conversation: string, value: unknown): NativeQuestion {
  const state = rec(value);
  const questions = list(state.questions).map(rec);
  const pending = questions.filter((question) => pendingProven(conversation, question));
  if (pending.length > 0) {
    return {
      pending: pending.map((question) => ({
        item: String(question.item_id),
        title:
          typeof question.title === "string"
            ? Array.from(question.title).slice(0, TITLE_CHARS).join("")
            : null,
        turn: String(question.turn_id),
      })),
      reason: null,
      role,
      status: "pending",
    };
  }
  const clear =
    state.status === "complete" &&
    state.complete === true &&
    questions.every((question) => question.state === "answered");
  return {
    pending: [],
    reason: clear ? null : reasonOf(state),
    role,
    status: clear ? "clear" : "unknown",
  };
}

function workerStatus(role: string, conversation: string, value: unknown): NativeWorker {
  const health = rec(value);
  const failures = workerFailures({ worker_health: { [conversation]: health } }).map(
    ([, child, turn, code]) => [String(child), String(turn), String(code)] as const,
  );
  const readable =
    health.status === "complete" &&
    health.complete === true &&
    health.schema_status !== "unknown" &&
    health.schema_status !== "unavailable";
  return {
    failures,
    reason: readable ? null : reasonOf(health),
    role,
    status: readable ? "ok" : "unknown",
  };
}

/**
 * Survey the route's Codex members and the game's Codex worker parents for `slot`. Nothing is
 * contacted when neither exists. Must run outside any store transaction.
 */
export async function surveyNative(
  context: NativeContext,
  game: GameLayout,
  members: readonly string[],
  slot: number,
): Promise<NativeSurvey> {
  const registry = readRegistry(context.layout);
  let parentRoles: readonly string[];
  try {
    parentRoles = loadReportsConfig(game.configFile).reports.workerParents;
  } catch {
    parentRoles = [];
  }
  const claudeRoles = new Set<string>();
  const codex = (roles: readonly string[]): Map<string, string> => {
    const selected = new Map<string, string>();
    for (const role of new Set(roles)) {
      if (!active(registry, role)) {
        continue;
      }
      const conversation = resolveConversation(registry, role);
      if (resolveHarness(registry, role) !== "codex") {
        claudeRoles.add(role);
      } else if (conversation !== null) {
        selected.set(role, conversation);
      }
    }
    return selected;
  };
  const memberIds = codex(members);
  const parentIds = codex(parentRoles);
  if (memberIds.size === 0 && parentIds.size === 0) {
    return { claudeRoles: [...claudeRoles].sort(), questions: [], workers: [] };
  }
  const recipients = [...new Set(memberIds.values())];
  const request: CollectRequest = {
    historyCursor: null,
    parents: [...new Set(parentIds.values())],
    recipients,
    routeMembers: recipients,
    slot,
    unblockDir: join(game.busDir, "unblock"),
  };
  const collected = await (context.collect ?? defaultCollect(context))(request);
  return {
    claudeRoles: [...claudeRoles].sort(),
    questions: [...memberIds].map(([role, id]) =>
      questionStatus(role, id, collected.question_state[id]),
    ),
    workers: [...parentIds].map(([role, id]) =>
      workerStatus(role, id, collected.worker_health[id]),
    ),
  };
}
