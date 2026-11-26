// Message lifecycle over the store: sent, delivered on the recipient's own read, then handled,
// superseded or retained by the recipient. Every function trusts its `actor`; the CLI resolves it
// through the registry fence or marks an unbound sender explicitly. Native wakes are separate
// and never change message state.
import type { SQLInputValue } from "node:sqlite";

import type { Store } from "./db.ts";
import { canonicalJson, normalizeLinks, REF, sha256 } from "./eventCodec.ts";
import { secretShape } from "./secrets.ts";
import {
  type Actor,
  ensure,
  type Json,
  type JsonObject,
  type LegacyOrigin,
  type MessageIntent,
  type MessageLink,
  type MessageState,
  type MessageView,
  type Retention,
  ROLE,
  type StoredEvent,
  UNBOUND_MESSAGE_SENDER,
} from "./types.ts";

/** Legacy message IDs keep their exact form; new sends use canonical UUIDs. */
export const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
export const MAX_BODY_BYTES = 1024 * 1024;
const OPEN: readonly MessageState[] = ["sent", "delivered", "retained"];

type Row = Record<string, SQLInputValue>;

function parse<T>(value: SQLInputValue | undefined): T {
  return JSON.parse((value as string | undefined) ?? "null") as T;
}

function bodyView(store: Pick<Store, "db">, row: Row): Pick<MessageView, "body" | "bodyExpired"> {
  const body = row.body as string;
  if (body === "") {
    const original = store.db
      .prepare("SELECT json_type(payload, '$.body') AS type FROM events WHERE seq = ?")
      .get(row.sent_seq!);
    if (original?.type === null) {
      return { bodyExpired: true };
    }
  }
  return { body };
}

function rowView(store: Pick<Store, "db">, row: Row, includeBody: boolean): MessageView {
  const nullable = (key: string) => (row[key] as string | null) ?? null;
  return {
    bodySha256: row.body_sha256 as string,
    closedAt: nullable("closed_at"),
    createdAt: row.created_at as string,
    deliveredAt: nullable("delivered_at"),
    evidence: parse<string[]>(row.evidence ?? "[]"),
    from: row.from_role as string,
    id: row.id as string,
    intent: row.intent as MessageIntent,
    legacy: row.legacy == null ? null : parse<LegacyOrigin | null>(row.legacy),
    links: parse<MessageLink[]>(row.links),
    retention: row.retention == null ? null : parse<Retention>(row.retention),
    state: row.state as MessageState,
    supersededBy: nullable("superseded_by"),
    to: row.to_role as string,
    unconfirmed: Number(row.unconfirmed) === 1,
    work: nullable("work"),
    worker: nullable("worker"),
    ...(includeBody ? bodyView(store, row) : {}),
  };
}

function messageRow(store: Pick<Store, "db">, id: string): Row | undefined {
  return store.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
}

export interface SendInput {
  readonly id: string;
  readonly to: string;
  readonly intent: MessageIntent;
  readonly body: string;
  readonly links?: readonly MessageLink[];
}

export interface SendResult {
  readonly message: MessageView;
  /** The same ID with the same content was already stored; nothing was written. */
  readonly duplicate: boolean;
}

/**
 * Commit the original. The same ID with identical sender, recipient, intent, body and links is
 * an idempotent no-op; any difference is `id-conflict`. Bodies matching a secret shape are
 * refused with `secret-shaped-body`.
 */
export function sendMessage(store: Store, actor: Actor, input: SendInput): SendResult {
  const unbound =
    actor.role === UNBOUND_MESSAGE_SENDER && actor.nativeId === null && actor.worker === undefined;
  ensure(actor.role !== null && (unbound || ROLE.test(actor.role)), "invalid-actor");
  ensure(MESSAGE_ID.test(input.id), "invalid-id");
  ensure(ROLE.test(input.to), "invalid-role");
  ensure(input.intent === "queue" || input.intent === "unblock", "invalid-intent");
  ensure(typeof input.body === "string" && input.body !== "", "empty-body");
  ensure(Buffer.byteLength(input.body, "utf8") <= MAX_BODY_BYTES, "body-too-large");
  ensure(secretShape(input.body) === null, "secret-shaped-body");
  const links = normalizeLinks(input.links ?? []);
  const bodySha256 = sha256(input.body);
  const intent = unbound ? "queue" : input.intent;
  return store.transaction(() => {
    const existing = messageRow(store, input.id);
    if (existing !== undefined) {
      ensure(
        existing.from_role === actor.role &&
          existing.to_role === input.to &&
          existing.intent === intent &&
          existing.body_sha256 === bodySha256 &&
          canonicalJson(parse(existing.links)) === canonicalJson(links),
        "id-conflict",
      );
      return { duplicate: true, message: rowView(store, existing, false) };
    }
    const at = store.now();
    store.append({
      actor,
      at,
      key: `msg.sent:${input.id}`,
      kind: "msg.sent",
      payload: {
        body: input.body,
        bodySha256,
        createdAt: at,
        from: actor.role,
        id: input.id,
        intent,
        links: links as unknown as Json,
        to: input.to,
        worker: actor.worker ?? null,
      },
    });
    return { duplicate: false, message: rowView(store, messageRow(store, input.id)!, false) };
  });
}

export interface InboxResult {
  readonly role: string;
  /** Messages this read moved from `sent` to `delivered`. */
  readonly delivered: number;
  readonly messages: readonly MessageView[];
}

/**
 * The caller's undelivered and open messages (all of its messages with `all`). Undelivered ones
 * become `delivered` in one event, which also clears the caller's pending and outstanding wake.
 */
export function readInbox(
  store: Store,
  actor: Actor,
  options: { readonly all?: boolean; readonly includeBody?: boolean } = {},
): InboxResult {
  const role = actor.role;
  ensure(role !== null && ROLE.test(role), "invalid-actor");
  return store.transaction(() => {
    const rows = (
      options.all === true
        ? store.db.prepare("SELECT * FROM messages WHERE to_role = ? ORDER BY sent_seq")
        : store.db.prepare(
            `SELECT * FROM messages WHERE to_role = ? AND state IN (${OPEN.map(() => "?").join(",")})
             ORDER BY sent_seq`,
          )
    ).all(role, ...(options.all === true ? [] : OPEN)) as Row[];
    const undelivered = rows.filter((row) => row.state === "sent").map((row) => row.id as string);
    const wake = store.db
      .prepare("SELECT pending, outstanding FROM wake_state WHERE role = ?")
      .get(role) as Row | undefined;
    let at: string | null = null;
    if (undelivered.length > 0 || Number(wake?.pending ?? 0) === 1 || wake?.outstanding != null) {
      at = store.now();
      store.append({
        actor,
        at,
        key: `inbox.read:${role}:${store.head().seq}`,
        kind: "inbox.read",
        payload: { delivered: undelivered, role },
      });
    }
    const messages = rows.map((row) =>
      rowView(
        store,
        row.state === "sent" && at !== null
          ? { ...row, delivered_at: at, state: "delivered" }
          : row,
        options.includeBody === true,
      ),
    );
    return { delivered: undelivered.length, messages, role };
  });
}

function recipientRow(store: Store, actor: Actor, id: string): Row {
  ensure(MESSAGE_ID.test(id), "invalid-id");
  const row = messageRow(store, id);
  ensure(row !== undefined, "missing");
  ensure(actor.role !== null && row.to_role === actor.role, "not-recipient");
  return row;
}

export interface CloseInput {
  readonly work?: string;
  readonly supersededBy?: string;
  readonly evidence?: readonly string[];
}

export interface WriteResult {
  readonly message: MessageView;
  readonly duplicate: boolean;
}

/**
 * Close the caller's own message in one write: `superseded` with `supersededBy`, else `handled`.
 * Repeating the same close is a no-op; any other change to a closed message is `already-closed`.
 */
export function closeMessage(
  store: Store,
  actor: Actor,
  id: string,
  input: CloseInput = {},
): WriteResult {
  const evidence = [...new Set(input.evidence ?? [])].sort();
  ensure(
    evidence.every((ref) => REF.test(ref)),
    "invalid-evidence",
  );
  ensure(input.work === undefined || REF.test(input.work), "invalid-work");
  const state: MessageState = input.supersededBy === undefined ? "handled" : "superseded";
  return store.transaction(() => {
    const row = recipientRow(store, actor, id);
    const payload: JsonObject = {
      evidence,
      id,
      state,
      supersededBy: input.supersededBy ?? null,
      work: input.work ?? null,
    };
    if (row.state === "handled" || row.state === "superseded") {
      ensure(
        row.state === state &&
          ((row.work as string | null) ?? null) === payload.work &&
          ((row.superseded_by as string | null) ?? null) === payload.supersededBy &&
          canonicalJson(parse(row.evidence ?? "[]")) === canonicalJson(evidence),
        "already-closed",
      );
      return { duplicate: true, message: rowView(store, row, false) };
    }
    if (input.supersededBy !== undefined) {
      ensure(
        input.supersededBy !== id && messageRow(store, input.supersededBy) !== undefined,
        "invalid-superseded-by",
      );
    }
    store.append({ actor, key: `msg.closed:${id}`, kind: "msg.closed", payload });
    return { duplicate: false, message: rowView(store, messageRow(store, id)!, false) };
  });
}

export interface RetainInput {
  readonly owner: string;
  readonly reason: string;
  readonly nextBoundary: string;
}

/** Retain the caller's own open message with an owner, reason and next review boundary. */
export function retainMessage(
  store: Store,
  actor: Actor,
  id: string,
  input: RetainInput,
): WriteResult {
  ensure(ROLE.test(input.owner), "invalid-owner");
  for (const value of [input.reason, input.nextBoundary]) {
    ensure(
      typeof value === "string" && value.trim() !== "" && value.length <= 1024,
      "invalid-retention",
    );
    ensure(secretShape(value) === null, "secret-shaped-body");
  }
  return store.transaction(() => {
    const row = recipientRow(store, actor, id);
    ensure(row.state !== "handled" && row.state !== "superseded", "already-closed");
    const current = row.retention == null ? null : parse<Retention>(row.retention);
    if (
      row.state === "retained" &&
      current?.owner === input.owner &&
      current.reason === input.reason &&
      current.nextBoundary === input.nextBoundary
    ) {
      return { duplicate: true, message: rowView(store, row, false) };
    }
    store.append({
      actor,
      key: `msg.retained:${id}:${store.head().seq}`,
      kind: "msg.retained",
      payload: { id, nextBoundary: input.nextBoundary, owner: input.owner, reason: input.reason },
    });
    return { duplicate: false, message: rowView(store, messageRow(store, id)!, false) };
  });
}

/** One message's metadata, without its body unless asked. */
export function messageStatus(
  store: Pick<Store, "db">,
  id: string,
  includeBody = false,
): MessageView {
  ensure(MESSAGE_ID.test(id), "invalid-id");
  const row = messageRow(store, id);
  ensure(row !== undefined, "missing");
  return rowView(store, row, includeBody);
}

/** Read one exact original only when the caller's role may see its body. */
export function messageWithBody(store: Pick<Store, "db">, viewer: string, id: string): MessageView {
  ensure(MESSAGE_ID.test(id), "invalid-id");
  const row = messageRow(store, id);
  ensure(row !== undefined, "missing");
  ensure(bodyVisibleTo(viewer, row.from_role, row.to_role), "message-not-visible");
  return rowView(store, row, true);
}

/** Messages in one recipient's inbox in the given states, oldest first. A review seam read. */
export function recipientMessages(
  store: Store,
  role: string,
  states: readonly MessageState[],
): MessageView[] {
  return (
    store.db
      .prepare(
        `SELECT * FROM messages WHERE to_role = ? AND state IN (${states.map(() => "?").join(",")})
         ORDER BY sent_seq`,
      )
      .all(role, ...states) as Row[]
  ).map((row) => rowView(store, row, false));
}

export const MESSAGE_KINDS = [
  "msg.sent",
  "msg.imported",
  "inbox.read",
  "msg.closed",
  "msg.retained",
];

export interface HistoryEntry {
  readonly seq: number;
  readonly kind: string;
  readonly at: string;
  readonly actor: { readonly role: string | null; readonly worker: string | null };
  readonly detail: JsonObject;
}

/** The role that may read every message body in history, beside each sender and recipient. */
const BODY_READER = "game-coordinator";

function bodyVisibleTo(viewer: string | null, from: unknown, to: unknown): boolean {
  return viewer !== null && (viewer === BODY_READER || viewer === from || viewer === to);
}

/**
 * Senders and recipients appear by role. A body appears only to a `viewer` that is the message's
 * sender, its recipient or `game-coordinator`; everyone else, and every read without a viewer,
 * gets metadata.
 */
function historyDetail(
  event: Pick<StoredEvent, "kind" | "payload">,
  viewer: string | null,
): JsonObject {
  const { payload } = event;
  if (event.kind === "msg.sent" || event.kind === "msg.imported") {
    if (bodyVisibleTo(viewer, payload.from, payload.to)) {
      return payload.body === undefined ? { ...payload, bodyExpired: true } : payload;
    }
    const rest: Record<string, Json> = { ...payload };
    delete rest.body;
    return rest;
  }
  return payload;
}

/**
 * Message events in seq order, optionally touching one role (as sender, recipient, reader or
 * actor) and at or after `since`, at most `limit` of them. `viewer` is the fenced caller's role
 * when bodies were asked for; it sees only the bodies `historyDetail` allows.
 */
export function messageHistory(
  store: Store,
  options: {
    readonly role?: string;
    readonly since?: string;
    readonly limit?: number;
    readonly viewer?: string;
  } = {},
): HistoryEntry[] {
  return historyQuery(
    store,
    MESSAGE_KINDS,
    options.role ?? null,
    options.since ?? null,
    options.limit ?? 1000,
    options.viewer ?? null,
  );
}

function historyQuery(
  store: Store,
  kinds: readonly string[],
  role: string | null,
  since: string | null,
  limit: number,
  viewer: string | null,
): HistoryEntry[] {
  const rows = store.db
    .prepare(
      `SELECT e.seq, e.kind, e.at, e.actor_role, e.actor_worker, e.payload FROM events e
       LEFT JOIN messages m ON m.id = json_extract(e.payload, '$.id')
       WHERE e.kind IN (${kinds.map(() => "?").join(",")})
         AND (? IS NULL OR e.at >= ?)
         AND (? IS NULL OR m.from_role = ? OR m.to_role = ?
              OR json_extract(e.payload, '$.role') = ? OR e.actor_role = ?)
       ORDER BY e.seq LIMIT ?`,
    )
    .all(...kinds, since, since, role, role, role, role, role, limit) as Row[];
  return rows.map((row) => ({
    actor: {
      role: (row.actor_role as string | null) ?? null,
      worker: (row.actor_worker as string | null) ?? null,
    },
    at: row.at as string,
    detail: historyDetail(
      { kind: row.kind as string, payload: parse<JsonObject>(row.payload) },
      viewer,
    ),
    kind: row.kind as string,
    seq: Number(row.seq),
  }));
}

export interface ExportResult {
  readonly since: string;
  /** Messages sent after `since`, with bodies, for re-recording under their original IDs. */
  readonly messages: readonly JsonObject[];
  /** Metadata for expired originals whose bodies cannot be re-recorded. */
  readonly expiredMessages?: readonly JsonObject[];
  /** Closes and retentions recorded after `since`, for the recipients to re-record. */
  readonly closes: readonly JsonObject[];
}

/** Sends, closes and retentions recorded after `since`, in seq order. Imports are excluded. */
export function exportSince(store: Store, since: string): ExportResult {
  const rows = store.db
    .prepare(
      `SELECT seq, kind, at, actor_role, payload FROM events
       WHERE kind IN ('msg.sent', 'msg.closed', 'msg.retained') AND at > ? ORDER BY seq`,
    )
    .all(since) as Row[];
  const messages: JsonObject[] = [];
  const expiredMessages: JsonObject[] = [];
  const closes: JsonObject[] = [];
  for (const row of rows) {
    const payload = parse<JsonObject>(row.payload);
    if (row.kind === "msg.sent") {
      const entry = { ...payload, at: row.at as string, seq: Number(row.seq) };
      if (payload.body === undefined) {
        expiredMessages.push({ ...entry, bodyExpired: true });
      } else {
        messages.push(entry);
      }
    } else {
      closes.push({
        ...payload,
        actor: (row.actor_role as string | null) ?? null,
        at: row.at as string,
        kind: row.kind as string,
        seq: Number(row.seq),
      });
    }
  }
  return { closes, ...(expiredMessages.length > 0 ? { expiredMessages } : {}), messages, since };
}
