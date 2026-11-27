import type { Layout } from "../../core/configuration/layout.ts";
import type { Registry } from "../../registry/schema.ts";
import { Store, type StoreContext } from "../db.ts";
import { verifiedWorkerForCaller } from "./workerProof.ts";

export function fileWorkerCaller(
  context: StoreContext,
  layout: Layout,
  registry: Registry,
  allowed: (store: Store, nativeId: string) => boolean,
) {
  return (nativeId: string) => {
    const store = Store.readLayout(context, layout);
    try {
      return store?.fileBacked === true && allowed(store, nativeId)
        ? verifiedWorkerForCaller(
            registry,
            store.events({ kinds: ["review.brief"] }).at(-1),
            context.clock().toISOString(),
            nativeId,
          )
        : null;
    } finally {
      store?.close();
    }
  };
}
