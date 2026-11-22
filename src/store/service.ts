// The message verbs as the CLI runs them: resolve the caller through the registry fence, open the
// store at the layout's root, apply one write, then attempt at most one wake. Every send reads
// var/registry.json; nothing is cached across calls.
import { randomUUID } from "node:crypto";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import type { Layout } from "../layout.ts";
import { resolveRole } from "../registry/resolve.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { MEMORY, Store } from "./db.ts";
import { type CallerOptions, resolveCaller } from "./identity.ts";
import {
  type CloseInput,
  closeMessage,
  type ExportResult,
  exportSince,
  type HistoryEntry,
  MESSAGE_ID,
  messageHistory,
  messageStatus,
  messageWithBody,
  readInbox,
  retainMessage,
  sendMessage,
} from "./messages.ts";
import { messageWake, unreadMessages } from "./messageWake.ts";
import { derivedId } from "./notices.ts";
import {
  type Actor,
  type MessageIntent,
  type MessageLink,
  type MessageView,
  type MessageWakeView,
  StoreError,
  type UnreadMessage,
} from "./types.ts";
import { type WakePorts, wakeRecipient, type WakeStatus } from "./wake.ts";

const COORDINATOR = "game-coordinator";

export interface StoreServiceContext {
  readonly layout: Layout;
  readonly env: NodeJS.ProcessEnv;
  readonly ports?: WakePorts;
  /** Test hook: the store clock. */
  readonly now?: () => string;
}

export async function withStore<T>(
  context: StoreServiceContext,
  body: (store: Store) => T | Promise<T>,
  options: { readonly createMissing?: boolean } = {},
): Promise<T> {
  const store =
    options.createMissing === false
      ? (Store.readLayout(context.layout) ?? Store.open(MEMORY))
      : Store.forLayout(context.layout, context.now === undefined ? {} : { now: context.now });
  try {
    return await body(store);
  } finally {
    store.close();
  }
}

export function registry(context: StoreServiceContext): Registry {
  try {
    return readRegistry(context.layout);
  } catch {
    throw new StoreError("registry-unavailable");
  }
}

function caller(
  context: StoreServiceContext,
  options: CallerOptions,
): Actor & { readonly role: string } {
  return resolveCaller(registry(context), context.env, options);
}

function registered(roles: Registry, role: string, code: string): string {
  try {
    return resolveRole(roles, role);
  } catch {
    throw new StoreError(code);
  }
}

export interface SendRequest {
  readonly to: string;
  readonly body: string;
  readonly intent?: MessageIntent;
  readonly id?: string;
  readonly links?: readonly MessageLink[];
}

export interface SendOutput {
  readonly schema: 1;
  readonly message: MessageView;
  readonly duplicate: boolean;
  readonly wake: { readonly status: WakeStatus; readonly evidence: MessageWakeView };
  readonly attention?: {
    readonly id: string;
    readonly status: "recorded" | "unavailable";
    readonly wake?: WakeStatus;
  };
}

/**
 * Route a confirmed work-message wake failure to the coordinator once. The original is already
 * committed. An attention write or wake failure must not turn that committed send into a retry.
 */
async function notifyCoordinator(
  ports: Parameters<typeof wakeRecipient>[0],
  actor: Actor,
  original: MessageView,
): Promise<NonNullable<SendOutput["attention"]> | undefined> {
  const { store } = ports;
  const id = derivedId("unread-unblock", original.id);
  try {
    const notice = store.transaction(() => {
      const current = messageStatus(store, original.id);
      const { outcome, wake } = messageWake(store, current.id, current.to, current.state);
      if (
        current.state !== "sent" ||
        wake === null ||
        (outcome !== "guarded" && outcome !== "failed")
      ) {
        return undefined;
      }
      return sendMessage(store, actor, {
        body:
          `Work original ${current.id} remains unread after a ${outcome} wake to ${current.to}. ` +
          "Review safe inbox collection for the exact original.",
        id,
        intent: "queue",
        links: [{ kind: "message", ref: current.id }],
        to: COORDINATOR,
      });
    });
    if (notice === undefined) {
      return undefined;
    }
    if (notice.duplicate) {
      return { id, status: "recorded" };
    }
    try {
      return { id, status: "recorded", wake: (await wakeRecipient(ports, COORDINATOR)).status };
    } catch {
      return { id, status: "recorded" };
    }
  } catch {
    return { id, status: "unavailable" };
  }
}

/** Commit the original, then attempt one guarded recipient wake. Repeating it is read-only. */
export async function storeSend(
  context: StoreServiceContext,
  options: CallerOptions,
  request: SendRequest,
): Promise<SendOutput> {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  const to = registered(roles, request.to, "recipient-unregistered");
  const id = request.id ?? randomUUID();
  if (!isCanonicalUuid(id)) {
    throw new StoreError("invalid-id");
  }
  return withStore(context, async (store) => {
    const sent = sendMessage(store, actor, {
      body: request.body,
      id,
      intent: request.intent ?? "queue",
      links: request.links ?? [],
      to,
    });
    const ports = {
      env: context.env,
      layout: context.layout,
      store,
      ...(context.ports === undefined ? {} : { ports: context.ports }),
    };
    const attempt = sent.duplicate ? undefined : await wakeRecipient(ports, to);
    const attention =
      !sent.duplicate &&
      (sent.message.intent === "unblock" ||
        sent.message.links.some(({ kind }) => kind === "work")) &&
      actor.role !== COORDINATOR &&
      to !== COORDINATOR &&
      Object.hasOwn(roles.roles, COORDINATOR) &&
      (attempt?.status === "guarded" || attempt?.status === "failed")
        ? await notifyCoordinator(ports, actor, sent.message)
        : undefined;
    const message = messageStatus(store, id);
    const evidence = messageWake(store, id, message.to, message.state);
    const previous: WakeStatus =
      message.state !== "sent"
        ? "none"
        : evidence.outcome === "accepted"
          ? "coalesced"
          : evidence.outcome === "unknown"
            ? "none"
            : evidence.outcome;
    return {
      ...(attention === undefined ? {} : { attention }),
      duplicate: sent.duplicate,
      message,
      schema: 1,
      wake: { evidence, status: attempt?.status ?? previous },
    };
  });
}

export interface InboxOutput {
  readonly schema: 1;
  readonly role: string;
  readonly delivered: number;
  readonly count: number;
  readonly messages: readonly MessageView[];
}

export async function storeInbox(
  context: StoreServiceContext,
  options: CallerOptions,
  selection: { readonly all?: boolean; readonly includeBody?: boolean },
): Promise<InboxOutput> {
  const actor = caller(context, options);
  return withStore(context, (store) => {
    const inbox = readInbox(store, actor, selection);
    return {
      count: inbox.messages.length,
      delivered: inbox.delivered,
      messages: inbox.messages,
      role: inbox.role,
      schema: 1,
    };
  });
}

export async function storeInboxPeek(
  context: StoreServiceContext,
  options: CallerOptions,
): Promise<{
  readonly schema: 1;
  readonly role: string;
  readonly count: number;
  readonly unread: readonly UnreadMessage[];
}> {
  const { role } = caller(context, options);
  return withStore(
    context,
    (store) => {
      const unread = unreadMessages(store, role);
      return { count: unread.length, role, schema: 1 as const, unread };
    },
    { createMissing: false },
  );
}

export interface WriteOutput {
  readonly schema: 1;
  readonly message: MessageView;
  readonly duplicate: boolean;
}

export async function storeDone(
  context: StoreServiceContext,
  options: CallerOptions,
  id: string,
  input: CloseInput,
): Promise<WriteOutput> {
  const actor = caller(context, options);
  return withStore(context, (store) => ({
    ...closeMessage(store, actor, id, input),
    schema: 1 as const,
  }));
}

export async function storeRetain(
  context: StoreServiceContext,
  options: CallerOptions,
  id: string,
  input: { readonly reason: string; readonly nextBoundary: string; readonly owner?: string },
): Promise<WriteOutput> {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  const owner = registered(roles, input.owner ?? actor.role, "owner-unregistered");
  return withStore(context, (store) => ({
    ...retainMessage(store, actor, id, {
      nextBoundary: input.nextBoundary,
      owner,
      reason: input.reason,
    }),
    schema: 1 as const,
  }));
}

export async function storeStatus(
  context: StoreServiceContext,
  id: string,
  bodyCaller?: CallerOptions,
): Promise<{ readonly schema: 1; readonly message: MessageView; readonly wake: MessageWakeView }> {
  const viewer = bodyCaller === undefined ? undefined : caller(context, bodyCaller).role;
  if (!MESSAGE_ID.test(id)) {
    throw new StoreError("invalid-id");
  }
  const store = Store.readLayout(context.layout);
  if (store === null) {
    throw new StoreError("missing");
  }
  try {
    const message =
      viewer === undefined ? messageStatus(store, id) : messageWithBody(store, viewer, id);
    return { message, schema: 1, wake: messageWake(store, id, message.to, message.state) };
  } finally {
    store.close();
  }
}

/**
 * Message events without bodies. With `includeBody` the caller is resolved through the registry
 * fence and sees the bodies of messages it sent or received, or every body as `game-coordinator`.
 */
export async function storeHistory(
  context: StoreServiceContext,
  selection: {
    readonly role?: string;
    readonly since?: string;
    readonly limit?: number;
    readonly includeBody?: boolean;
    readonly caller?: CallerOptions;
  },
): Promise<{ readonly schema: 1; readonly events: readonly HistoryEntry[] }> {
  const viewer =
    selection.includeBody === true ? caller(context, selection.caller ?? {}).role : undefined;
  return withStore(
    context,
    (store) => ({
      events: messageHistory(store, {
        ...(selection.limit === undefined ? {} : { limit: selection.limit }),
        ...(selection.role === undefined ? {} : { role: selection.role }),
        ...(selection.since === undefined ? {} : { since: selection.since }),
        ...(viewer === undefined ? {} : { viewer }),
      }),
      schema: 1 as const,
    }),
    { createMissing: false },
  );
}

export async function storeExport(
  context: StoreServiceContext,
  since: string,
): Promise<{ readonly schema: 1 } & ExportResult> {
  return withStore(context, (store) => ({ ...exportSince(store, since), schema: 1 as const }), {
    createMissing: false,
  });
}

export async function storeRebuild(context: StoreServiceContext): Promise<{
  readonly schema: 1;
  readonly verified: true;
  readonly events: number;
  readonly head: { readonly seq: number; readonly hash: string };
}> {
  return withStore(context, (store) => ({
    ...store.rebuild(),
    schema: 1 as const,
    verified: true as const,
  }));
}
