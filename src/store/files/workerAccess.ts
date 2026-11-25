import type { DatabaseSync } from "node:sqlite";

import type { Layout } from "../../core/layout.ts";
import type { Registry } from "../../registry/schema.ts";
import { Store, type StoreContext } from "../db.ts";
import { latestStoreReview } from "../eventCodec.ts";
import { verifiedWorkerForCaller } from "./workerProof.ts";

export function fileWorkerCaller(
  context: StoreContext,
  layout: Layout,
  registry: Registry,
  allowed: (index: DatabaseSync, nativeId: string) => boolean,
) {
  return (nativeId: string) => {
    const store = Store.readLayout(context, layout);
    try {
      return store?.fileBacked === true && allowed(store.db, nativeId)
        ? verifiedWorkerForCaller(
            registry,
            latestStoreReview(store.db),
            context.clock().toISOString(),
            nativeId,
          )
        : null;
    } finally {
      store?.close();
    }
  };
}
