// The store-mode switch. The coordination store is the selected mode when `store cutover --apply`
// has written its fence (`var/work-protocol-fence.json` with kind `store-cutover`) and
// `coordination.db` exists. Without that fence every path keeps its 1.3 behaviour, so restoring
// the previous fence switches this kit back and leaves a 1.3 CLI working unchanged.
import { existsSync } from "node:fs";

import type { Layout } from "../layout.ts";
import { readStoreCutover } from "../protocol/layout.ts";
import { storePath } from "./db.ts";
import { StoreError } from "./types.ts";

export type StoreModeName = "store" | "legacy";

export interface StoreMode {
  readonly mode: StoreModeName;
  /** The cutover time the fence records, or null in legacy mode. */
  readonly cutoverAt: string | null;
}

/**
 * The selected mode. A cutover fence without `coordination.db` is refused with `store-missing`:
 * legacy writers are fenced and the store cannot be read, so nothing may proceed.
 */
export function storeMode(layout: Layout): StoreMode {
  const fence = readStoreCutover(layout);
  if (fence === null) {
    return { cutoverAt: null, mode: "legacy" };
  }
  if (!existsSync(storePath(layout))) {
    throw new StoreError("store-missing");
  }
  return { cutoverAt: fence.cutoverAt, mode: "store" };
}

export function isStoreMode(layout: Layout): boolean {
  return storeMode(layout).mode === "store";
}
