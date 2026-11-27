import { loadLayout } from "../../core/configuration/layout.ts";
import type { StoreServiceContext } from "../../store/context.ts";
import { systemClock, verbFamily } from "../args.ts";

/** What a store verb runs against: the service context and the caller's working directory. */
interface StoreCommandContext extends StoreServiceContext {
  readonly cwd: string;
}

/** The store verbs' wrapper: the coordinator layout from `root`, the real clock and environment. */
export const storeVerb = verbFamily("store", (io, root): StoreCommandContext => ({
  clock: systemClock,
  cwd: io.cwd,
  env: io.env,
  layout: loadLayout(root),
}));
