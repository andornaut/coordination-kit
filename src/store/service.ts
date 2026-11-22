// The message verbs as the CLI runs them: resolve the caller through the registry fence, open the
// store at the layout's root, apply one write, then attempt at most one wake. Every send reads
// var/registry.json; nothing is cached across calls.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { isCanonicalUuid } from "../adapters/shared/ids.ts";
import type { Layout } from "../layout.ts";
import { resolveRole } from "../registry/resolve.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { MEMORY, Store, storePath } from "./db.ts";
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
import {
  type Actor,
  type MessageIntent,
  type MessageLink,
  type MessageView,
  StoreError,
} from "./types.ts";
import { type WakePorts, wakeRecipient, type WakeStatus } from "./wake.ts";

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
  const path = storePath(context.layout);
  const store = Store.open(
    options.createMissing === false && !existsSync(path) ? MEMORY : path,
    context.now === undefined ? {} : { now: context.now },
  );
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
  readonly wake: { readonly status: WakeStatus };
}

/** Commit the original, then attempt one guarded wake. A repeated send retries only the wake. */
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
    const wake = await wakeRecipient(
      {
        env: context.env,
        layout: context.layout,
        store,
        ...(context.ports === undefined ? {} : { ports: context.ports }),
      },
      to,
    );
    return {
      duplicate: sent.duplicate,
      message: sent.message,
      schema: 1,
      wake: { status: wake.status },
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
): Promise<{ readonly schema: 1; readonly message: MessageView }> {
  const viewer = bodyCaller === undefined ? undefined : caller(context, bodyCaller).role;
  if (!MESSAGE_ID.test(id)) {
    throw new StoreError("invalid-id");
  }
  const path = storePath(context.layout);
  if (!existsSync(path)) {
    throw new StoreError("missing");
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const message =
      viewer === undefined ? messageStatus({ db }, id) : messageWithBody({ db }, viewer, id);
    return { message, schema: 1 };
  } finally {
    db.close();
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
  return withStore(context, (store) => ({
    events: messageHistory(store, {
      ...(selection.limit === undefined ? {} : { limit: selection.limit }),
      ...(selection.role === undefined ? {} : { role: selection.role }),
      ...(selection.since === undefined ? {} : { since: selection.since }),
      ...(viewer === undefined ? {} : { viewer }),
    }),
    schema: 1 as const,
  }));
}

export async function storeExport(
  context: StoreServiceContext,
  since: string,
): Promise<{ readonly schema: 1 } & ExportResult> {
  return withStore(context, (store) => ({ ...exportSince(store, since), schema: 1 as const }));
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
