// The message verbs as the CLI runs them: read the live registry, open the store, apply one
// write, then attempt at most one wake. Only send can accept a caller without a binding.
import { randomUUID } from "node:crypto";

import { isCanonicalUuid } from "../core/ids.ts";
import type { Layout, Permission } from "../core/layout.ts";
import { isPermitted } from "../registry/permissions.ts";
import { resolveRole } from "../registry/resolve.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { MEMORY, READ_ONLY_CLOCK, Store, type StoreContext } from "./db.ts";
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
import { firstMessageWake, messageWake, unreadMessages } from "./messageWake.ts";
import { requirePermission } from "./permissions.ts";
import {
  type Actor,
  type MessageIntent,
  type MessageLink,
  type MessageView,
  type MessageWakeView,
  StoreError,
  UNBOUND_MESSAGE_SENDER,
  type UnreadMessage,
} from "./types.ts";
import { type WakePorts, wakeRecipient, type WakeStatus } from "./wake.ts";

export interface StoreServiceContext extends StoreContext {
  readonly layout: Layout;
  readonly ports?: WakePorts;
}

export async function withStore<T>(
  context: StoreServiceContext,
  body: (store: Store) => T | Promise<T>,
  options: { readonly createMissing?: boolean } = {},
): Promise<T> {
  const store =
    options.createMissing === false
      ? (Store.readLayout(context, context.layout) ?? Store.open(READ_ONLY_CLOCK, MEMORY))
      : Store.forLayout(context, context.layout);
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

function bodyViewer(context: StoreServiceContext, options: CallerOptions) {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  return {
    viewer: actor.role,
    readAll: isPermitted(context.layout, roles, actor, "messages:read-all"),
  };
}

function requireStorePermission(
  context: StoreServiceContext,
  options: CallerOptions,
  permission: Permission,
): void {
  if (context.layout.mode === "legacy") return;
  const roles = registry(context);
  requirePermission(context.layout, roles, resolveCaller(roles, context.env, options), permission);
}

function registered(roles: Registry, role: string, code: string): string {
  try {
    return resolveRole(roles, role);
  } catch {
    throw new StoreError(code);
  }
}

function sender(roles: Registry, env: NodeJS.ProcessEnv, options: CallerOptions): Actor {
  try {
    return resolveCaller(roles, env, options);
  } catch (error) {
    if (
      error instanceof StoreError &&
      (error.code === "caller-unbound" || error.code === "caller-unidentified")
    ) {
      return { nativeId: null, role: UNBOUND_MESSAGE_SENDER };
    }
    throw error;
  }
}

interface SendRequest {
  readonly to: string;
  readonly body: string;
  readonly intent?: MessageIntent;
  readonly id?: string;
  readonly links?: readonly MessageLink[];
}

interface SendOutput {
  readonly schema: 1;
  readonly message: MessageView;
  readonly duplicate: boolean;
  readonly wake: { readonly status: WakeStatus; readonly evidence: MessageWakeView };
}

/** Commit the original, then attempt one guarded recipient wake. Repeating it is read-only. */
export async function storeSend(
  context: StoreServiceContext,
  options: CallerOptions,
  request: SendRequest,
): Promise<SendOutput> {
  const roles = registry(context);
  const actor = sender(roles, context.env, options);
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
      duplicate: sent.duplicate,
      message,
      schema: 1,
      wake: { evidence, status: attempt?.status ?? previous },
    };
  });
}

interface InboxOutput {
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
  return withStore(context, (store) =>
    store.transaction(() => {
      const inbox = readInbox(store, actor, selection);
      return {
        count: inbox.messages.length,
        delivered: inbox.delivered,
        messages: inbox.messages,
        role: inbox.role,
        schema: 1,
      };
    }),
  );
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

interface WriteOutput {
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
  return withStore(context, (store) =>
    store.transaction(() => {
      return { ...closeMessage(store, actor, id, input), schema: 1 as const };
    }),
  );
}

export async function storeRetain(
  context: StoreServiceContext,
  options: CallerOptions,
  id: string,
  input: {
    readonly reason: string;
    readonly nextBoundary: string;
    readonly owner?: string;
    readonly evidence?: readonly string[];
  },
): Promise<WriteOutput> {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  const owner = registered(roles, input.owner ?? actor.role, "owner-unregistered");
  return withStore(context, (store) =>
    store.transaction(() => {
      const result = retainMessage(store, actor, id, { ...input, owner });
      return { ...result, schema: 1 as const };
    }),
  );
}

export async function storeStatus(
  context: StoreServiceContext,
  id: string,
  bodyCaller?: CallerOptions,
): Promise<{
  readonly schema: 1;
  readonly message: MessageView;
  readonly firstWake: Omit<MessageWakeView, "nextAction"> | null;
  readonly wake: MessageWakeView;
}> {
  const bodyAccess = bodyCaller === undefined ? undefined : bodyViewer(context, bodyCaller);
  if (!MESSAGE_ID.test(id)) {
    throw new StoreError("invalid-id");
  }
  const store = Store.readLayout(context, context.layout);
  if (store === null) {
    throw new StoreError("missing");
  }
  try {
    const message =
      bodyAccess === undefined
        ? messageStatus(store, id)
        : messageWithBody(store, bodyAccess.viewer, id, bodyAccess.readAll);
    return {
      firstWake: firstMessageWake(store, id, message.to),
      message,
      schema: 1,
      wake: messageWake(store, id, message.to, message.state),
    };
  } finally {
    store.close();
  }
}

/**
 * Message events without bodies. With `includeBody` the caller is resolved through the registry
 * fence. It sees its own exchanges, with workspace-wide visibility requiring an explicit grant.
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
  const bodyAccess =
    selection.includeBody === true ? bodyViewer(context, selection.caller ?? {}) : undefined;
  return withStore(
    context,
    (store) => ({
      events: messageHistory(store, {
        ...(selection.limit === undefined ? {} : { limit: selection.limit }),
        ...(selection.role === undefined ? {} : { role: selection.role }),
        ...(selection.since === undefined ? {} : { since: selection.since }),
        ...bodyAccess,
      }),
      schema: 1 as const,
    }),
    { createMissing: false },
  );
}

export async function storeExport(
  context: StoreServiceContext,
  since: string,
  options: CallerOptions = {},
): Promise<{ readonly schema: 1 } & ExportResult> {
  requireStorePermission(context, options, "messages:read-all");
  return withStore(context, (store) => ({ ...exportSince(store, since), schema: 1 as const }), {
    createMissing: false,
  });
}

export async function storeRebuild(context: StoreServiceContext, options: CallerOptions = {}): Promise<{
  readonly schema: 1;
  readonly verified: true;
  readonly events: number;
  readonly head: { readonly seq: number; readonly hash: string };
}> {
  requireStorePermission(context, options, "store:maintain");
  return withStore(context, (store) => ({
    ...store.rebuild(),
    schema: 1 as const,
    verified: true as const,
  }));
}
