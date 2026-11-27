import type { Layout, Permission } from "../core/configuration/layout.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { MEMORY, READ_ONLY_CLOCK, Store, type StoreContext } from "./db.ts";
import type { WakePorts } from "./messages/wake.ts";
import { type CallerOptions, resolveCaller } from "./sessions/identity.ts";
import { requirePermission } from "./sessions/permissions.ts";
import { StoreError } from "./types.ts";

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

export function requireStorePermission(
  context: StoreServiceContext,
  options: CallerOptions,
  permission: Permission,
): void {
  if (context.layout.mode === "legacy") {
    return;
  }
  const roles = registry(context);
  requirePermission(context.layout, roles, resolveCaller(roles, context.env, options), permission);
}
