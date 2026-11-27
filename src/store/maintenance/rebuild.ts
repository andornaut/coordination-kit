import { requireStorePermission, type StoreServiceContext, withStore } from "../context.ts";
import type { CallerOptions } from "../sessions/identity.ts";

export async function storeRebuild(
  context: StoreServiceContext,
  options: CallerOptions = {},
): Promise<{
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
