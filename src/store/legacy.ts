// One-way import of the legacy message records (schema 1 `<sha256(id)>.json` files) into the
// store, keeping each original ID, body, payload hash, worker target and evidence. Import reads
// the legacy directories only; it never writes, moves or locks them.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { isRecord } from "../adapters/shared/pyjson.ts";
import type { Layout } from "../layout.ts";
import { messageEnvelope } from "../messages/envelope.ts";
import { messageDirectory } from "../messages/paths.ts";
import type { MessageInput } from "../messages/types.ts";
import { canonicalJson, type Store } from "./db.ts";
import { MESSAGE_ID, ROLE, sha256 } from "./messages.ts";
import type { Actor, Json, JsonObject, MessageState } from "./types.ts";

export interface LegacySource {
  /** `transport` is the protocol state root's store; `pre-activation` is `var/game-dev/messages`. */
  readonly label: "transport" | "pre-activation";
  readonly path: string;
}

/** The legacy message directories that exist, the protocol store first. */
export function legacySources(layout: Layout): LegacySource[] {
  const transport = messageDirectory(layout);
  const preActivation = join(layout.reviewDir, "messages");
  const sources: LegacySource[] = [];
  if (existsSync(transport)) {
    sources.push({
      label: transport === preActivation ? "pre-activation" : "transport",
      path: transport,
    });
  }
  if (transport !== preActivation && existsSync(preActivation)) {
    sources.push({ label: "pre-activation", path: preActivation });
  }
  return sources;
}

/** The mapped form of one legacy record: the `msg.imported` payload. */
export interface ImportRecord {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly intent: "queue" | "unblock";
  readonly body: string;
  readonly bodySha256: string;
  readonly links: readonly { readonly kind: string; readonly ref: string }[];
  readonly createdAt: string;
  readonly state: MessageState;
  readonly unconfirmed: boolean;
  readonly deliveredAt: string | null;
  readonly closedAt: null;
  readonly work: null;
  readonly supersededBy: null;
  readonly evidence: readonly string[];
  readonly retention: {
    readonly owner: string;
    readonly reason: string;
    readonly nextBoundary: string;
  } | null;
  readonly legacy: {
    readonly state: string;
    readonly payloadHash: string;
    readonly source: string;
  };
}

type Attempt = {
  readonly state: string;
  readonly started: string;
  readonly completed: string | null;
  readonly source: {
    readonly hop: string;
    readonly requestId: string;
    readonly owner: {
      readonly harness: string;
      readonly nativeId: string;
      readonly parentBinding: { readonly nativeId: string } | null;
    };
  };
};

function nativeRecipient(attempt: Attempt): string {
  return attempt.source.hop === "parent"
    ? (attempt.source.owner.parentBinding?.nativeId ?? attempt.source.owner.nativeId)
    : attempt.source.owner.nativeId;
}

/** An unclaimed Claude spool entry: the consumer never took it, so it was never delivered. */
function unclaimed(directory: string, attempt: Attempt): boolean {
  return (
    attempt.source.owner.harness === "claude" &&
    /^[A-Za-z0-9_-]+$/.test(attempt.source.requestId) &&
    /^[0-9a-f-]{36}$/.test(nativeRecipient(attempt)) &&
    existsSync(
      join(
        directory,
        "recipients",
        nativeRecipient(attempt),
        "unblock",
        "claude-spool",
        `${attempt.source.requestId}.json`,
      ),
    )
  );
}

function attemptValid(value: unknown): value is Attempt {
  return (
    isRecord(value) &&
    typeof value.state === "string" &&
    typeof value.started === "string" &&
    (value.completed === null || typeof value.completed === "string") &&
    isRecord(value.source) &&
    typeof value.source.hop === "string" &&
    typeof value.source.requestId === "string" &&
    isRecord(value.source.owner) &&
    typeof value.source.owner.harness === "string" &&
    typeof value.source.owner.nativeId === "string"
  );
}

const UNCERTAIN = new Set(["sending", "ambiguous"]);
const ACCEPTED = new Set(["accepted", "parent-required"]);

/**
 * Map one legacy record, or return why it is invalid. queued, blocked and records without an
 * attempt become `sent`; accepted and parent-required become `delivered`; sending and ambiguous
 * become `delivered` with `unconfirmed`, unless their Claude spool entry is still unclaimed, which
 * makes them `sent`; handled and superseded close with their evidence; retained and held keep
 * owner, reason and boundary.
 */
export function mapLegacyRecord(
  source: LegacySource,
  name: string,
  value: unknown,
): ImportRecord | { readonly invalid: string } {
  if (!isRecord(value) || value.schema !== 1 || !isRecord(value.envelope)) {
    return { invalid: "shape" };
  }
  let envelope;
  try {
    envelope = messageEnvelope(value.envelope as unknown as MessageInput);
  } catch {
    return { invalid: "envelope" };
  }
  if (
    !isDeepStrictEqual(envelope, value.envelope) ||
    sha256(envelope.id) !== name ||
    !MESSAGE_ID.test(envelope.id) ||
    !ROLE.test(envelope.fromRole) ||
    !ROLE.test(envelope.toRole)
  ) {
    return { invalid: "binding" };
  }
  const attempts = Array.isArray(value.attempts) ? value.attempts : null;
  const evidence = Array.isArray(value.evidence) ? value.evidence : null;
  const state = typeof value.state === "string" ? value.state : null;
  if (attempts === null || !attempts.every(attemptValid) || evidence === null || state === null) {
    return { invalid: "record" };
  }
  const last = attempts.at(-1);
  const accepted = attempts.findLast((attempt) => ACCEPTED.has(attempt.state));
  let delivery: { state: "sent" | "delivered"; unconfirmed: boolean; at: string | null };
  if (last !== undefined && UNCERTAIN.has(last.state)) {
    delivery = unclaimed(source.path, last)
      ? { at: null, state: "sent", unconfirmed: false }
      : { at: last.completed ?? last.started, state: "delivered", unconfirmed: true };
  } else if (accepted !== undefined) {
    delivery = {
      at: accepted.completed ?? accepted.started,
      state: "delivered",
      unconfirmed: false,
    };
  } else {
    delivery = { at: null, state: "sent", unconfirmed: false };
  }
  let mapped: MessageState;
  let retention: ImportRecord["retention"] = null;
  switch (state) {
    case "queued":
    case "blocked":
      mapped = "sent";
      delivery = { at: null, state: "sent", unconfirmed: false };
      break;
    case "accepted":
    case "parent-required":
      mapped = "delivered";
      delivery = { ...delivery, state: "delivered", unconfirmed: false };
      break;
    case "sending":
    case "ambiguous":
      mapped = delivery.state;
      break;
    case "handled":
    case "superseded":
      mapped = state;
      delivery = { ...delivery, unconfirmed: false };
      break;
    case "retained":
    case "held": {
      const kept = value.retention;
      if (
        !isRecord(kept) ||
        typeof kept.ownerRole !== "string" ||
        !ROLE.test(kept.ownerRole) ||
        typeof kept.reason !== "string" ||
        typeof kept.nextBoundary !== "string"
      ) {
        return { invalid: "retention" };
      }
      mapped = "retained";
      retention = { nextBoundary: kept.nextBoundary, owner: kept.ownerRole, reason: kept.reason };
      break;
    }
    default:
      return { invalid: "state" };
  }
  const refs = evidence
    .filter(
      (item) => isRecord(item) && typeof item.kind === "string" && typeof item.ref === "string",
    )
    .map((item) => `${(item as JsonObject).kind as string}:${(item as JsonObject).ref as string}`);
  return {
    body: envelope.body,
    bodySha256: sha256(envelope.body),
    closedAt: null,
    createdAt: envelope.created,
    deliveredAt: delivery.at,
    evidence: refs,
    from: envelope.fromRole,
    id: envelope.id,
    intent: envelope.intent,
    legacy: { payloadHash: envelope.payloadHash, source: source.label, state },
    links:
      envelope.workerId === undefined ? [] : [{ kind: "worker-target", ref: envelope.workerId }],
    retention,
    state: mapped,
    supersededBy: null,
    to: envelope.toRole,
    unconfirmed: delivery.unconfirmed,
    work: null,
  };
}

export type ImportAction = "insert" | "unchanged" | "changed" | "invalid" | "duplicate";

export interface ImportDiff {
  readonly id: string | null;
  readonly file: string;
  readonly source: LegacySource["label"];
  readonly action: ImportAction;
  readonly legacyState: string | null;
  readonly state: MessageState | null;
  readonly unconfirmed: boolean;
  readonly reason?: string;
}

export interface ImportReport {
  readonly schema: 1;
  readonly dryRun: boolean;
  readonly sources: readonly {
    readonly label: string;
    readonly path: string;
    readonly records: number;
  }[];
  readonly counts: {
    readonly legacy: Readonly<Record<string, number>>;
    readonly mapped: Readonly<Record<string, number>>;
    readonly actions: Readonly<Record<ImportAction, number>>;
  };
  readonly diff: readonly ImportDiff[];
  readonly imported: number;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

const BATCH = 250;

/**
 * Plan, and unless `dryRun` apply, the import of every legacy source. A message ID already in the
 * store is `unchanged` when its import event holds the same mapped record and `changed` (left as
 * is) otherwise; an ID seen in an earlier source is a `duplicate`. Re-running is a no-op.
 */
export function importLegacy(
  store: Store,
  actor: Actor,
  sources: readonly LegacySource[],
  options: { readonly dryRun: boolean },
): ImportReport {
  const diff: ImportDiff[] = [];
  const legacy: Record<string, number> = {};
  const mapped: Record<string, number> = {};
  const actions: Record<ImportAction, number> = {
    changed: 0,
    duplicate: 0,
    insert: 0,
    invalid: 0,
    unchanged: 0,
  };
  const pending: ImportRecord[] = [];
  const seen = new Map<string, string>();
  const summary: { label: string; path: string; records: number }[] = [];
  for (const source of sources) {
    const names = readdirSync(source.path)
      .filter((file) => /^[0-9a-f]{64}\.json$/.test(file))
      .sort();
    summary.push({ label: source.label, path: source.path, records: names.length });
    for (const file of names) {
      let value: unknown;
      try {
        value = JSON.parse(readFileSync(join(source.path, file), "utf8"));
      } catch {
        value = undefined;
      }
      const record = mapLegacyRecord(source, file.slice(0, -".json".length), value);
      const legacyState = isRecord(value) && typeof value.state === "string" ? value.state : null;
      const base = { file, legacyState, source: source.label };
      if ("invalid" in record) {
        actions.invalid++;
        diff.push({
          ...base,
          action: "invalid",
          id: null,
          reason: record.invalid,
          state: null,
          unconfirmed: false,
        });
        continue;
      }
      const payload = canonicalJson(record);
      // Sources hold copies of one record; only the mapped content, not the source label, counts.
      const content = canonicalJson({ ...record, legacy: { ...record.legacy, source: null } });
      const earlier = seen.get(record.id);
      if (earlier !== undefined) {
        actions.duplicate++;
        diff.push({
          ...base,
          action: "duplicate",
          id: record.id,
          ...(earlier === content ? {} : { reason: "differs-from-earlier-source" }),
          state: record.state,
          unconfirmed: record.unconfirmed,
        });
        continue;
      }
      seen.set(record.id, content);
      increment(legacy, record.legacy.state);
      increment(mapped, record.unconfirmed ? `${record.state}-unconfirmed` : record.state);
      const stored = store.eventByKey(`msg.imported:${record.id}`);
      const present =
        stored !== undefined ||
        store.db.prepare("SELECT 1 FROM messages WHERE id = ?").get(record.id) !== undefined;
      const action: ImportAction = !present
        ? "insert"
        : stored !== undefined && canonicalJson(stored.payload) === payload
          ? "unchanged"
          : "changed";
      actions[action]++;
      diff.push({
        ...base,
        action,
        id: record.id,
        state: record.state,
        unconfirmed: record.unconfirmed,
      });
      if (action === "insert") {
        pending.push(record);
      }
    }
  }
  if (!options.dryRun) {
    for (let start = 0; start < pending.length; start += BATCH) {
      store.transaction(() => {
        for (const record of pending.slice(start, start + BATCH)) {
          store.append({
            actor,
            key: `msg.imported:${record.id}`,
            kind: "msg.imported",
            payload: record as unknown as { readonly [key: string]: Json },
          });
        }
      });
    }
  }
  return {
    counts: { actions, legacy, mapped },
    diff,
    dryRun: options.dryRun,
    imported: options.dryRun ? 0 : pending.length,
    schema: 1,
    sources: summary,
  };
}
