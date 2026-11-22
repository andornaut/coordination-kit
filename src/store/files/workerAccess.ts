import type { DatabaseSync } from "node:sqlite";

import type { Layout } from "../../layout.ts";
import type { Registry } from "../../registry/schema.ts";
import { Store } from "../db.ts";
import { latestStoreReview } from "../eventCodec.ts";
import { verifiedWorkerForCaller } from "./workerProof.ts";

export function fileWorkerCaller(
  layout: Layout,
  registry: Registry,
  now: () => string,
  allowed: (index: DatabaseSync, nativeId: string) => boolean,
) {
  return (nativeId: string) => {
    const store = Store.readLayout(layout);
    try {
      return store?.fileBacked === true && allowed(store.db, nativeId)
        ? verifiedWorkerForCaller(registry, latestStoreReview(store.db), now(), nativeId)
        : null;
    } finally {
      store?.close();
    }
  };
}
