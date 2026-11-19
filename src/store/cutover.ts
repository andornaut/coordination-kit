// `store cutover`: the cutover steps this kit owns. `--apply` is the coordinator's alone: it
// creates the store, writes the store cutover fence (the protocol generation fence one higher, so
// legacy message writers fail closed), imports the legacy message stores, records the cutover
// event and wakes each recipient left with undelivered messages. `--dry-run` writes nothing and
// prints what `--apply` would do, with counts.
import { existsSync } from "node:fs";

import { readJsonIfExists, writeJsonDurable } from "../durable.ts";
import {
  protocolPaths,
  readStoreCutover,
  resolveProtocolManagement,
  type StoreCutoverFence,
  withProtocolLayout,
} from "../protocol/layout.ts";
import { captureProtocolSelection } from "../protocol/selection.ts";
import { readRegistry } from "../registry/store.ts";
import { MEMORY, Store, storePath } from "./db.ts";
import { type CallerOptions, resolveCaller } from "./identity.ts";
import { importLegacy, type ImportReport, legacySources } from "./legacy.ts";
import type { StoreServiceContext } from "./service.ts";
import { type Json, StoreError } from "./types.ts";
import { pendingWakeRoles, wakeRecipient, type WakeStatus } from "./wake.ts";

/** The only role that may apply the cutover. */
export const COORDINATOR_ROLE = "game-coordinator";

export interface CutoverOutput {
  readonly schema: 1;
  readonly kind: "store-cutover";
  readonly dryRun: boolean;
  /** True when the cutover was already applied; nothing was done. */
  readonly applied: boolean;
  readonly cutoverAt: string | null;
  readonly store: { readonly path: string; readonly exists: boolean };
  readonly fence: {
    readonly management: string;
    readonly previousGeneration: number;
    readonly generation: number;
  };
  readonly import: Pick<ImportReport, "counts" | "imported" | "sources">;
  /** Recipients with undelivered messages: woken on apply, listed on a dry run. */
  readonly wakes: readonly { readonly role: string; readonly status: WakeStatus | "planned" }[];
  /** Undelivered imported messages a dry run would add to those recipients. */
  readonly importedUndelivered: number;
}

function cutoverRecorded(store: Store, cutoverAt: string): boolean {
  return store.eventByKey(`store.cutover:${cutoverAt}`) !== undefined;
}

export async function storeCutover(
  context: StoreServiceContext,
  options: CallerOptions,
  selection: { readonly apply: boolean },
): Promise<CutoverOutput> {
  const { layout } = context;
  const management = resolveProtocolManagement(layout);
  if (management.status === "pending") {
    throw new StoreError("protocol-pending");
  }
  const actor = selection.apply
    ? (() => {
        let registry;
        try {
          registry = readRegistry(layout);
        } catch {
          throw new StoreError("registry-unavailable");
        }
        const caller = resolveCaller(registry, context.env, options);
        if (caller.role !== COORDINATOR_ROLE) {
          throw new StoreError("not-coordinator");
        }
        return caller;
      })()
    : { nativeId: null, role: null };
  const existing = readStoreCutover(layout);
  const previousGeneration =
    existing?.previous?.generation ?? (management.status === "active" ? management.generation : 0);
  const fenceView = {
    generation: existing?.generation ?? previousGeneration + 1,
    management: management.status,
    previousGeneration,
  };
  const path = storePath(layout);
  const exists = existsSync(path);
  const store = Store.open(
    !selection.apply && !exists ? MEMORY : path,
    context.now === undefined ? {} : { now: context.now },
  );
  try {
    if (existing !== null && cutoverRecorded(store, existing.cutoverAt)) {
      return {
        applied: true,
        cutoverAt: existing.cutoverAt,
        dryRun: !selection.apply,
        fence: fenceView,
        import: {
          counts: {
            actions: { changed: 0, duplicate: 0, insert: 0, invalid: 0, unchanged: 0 },
            legacy: {},
            mapped: {},
          },
          imported: 0,
          sources: [],
        },
        importedUndelivered: 0,
        kind: "store-cutover",
        schema: 1,
        store: { exists: true, path },
        wakes: [],
      };
    }
    const sources = legacySources(layout);
    if (!selection.apply) {
      const report = importLegacy(store, actor, sources, { dryRun: true });
      const undelivered = report.diff.filter(
        (row) => row.action === "insert" && row.state === "sent",
      ).length;
      return {
        applied: false,
        cutoverAt: existing?.cutoverAt ?? null,
        dryRun: true,
        fence: fenceView,
        import: { counts: report.counts, imported: 0, sources: report.sources },
        importedUndelivered: undelivered,
        kind: "store-cutover",
        schema: 1,
        store: { exists, path },
        wakes: pendingWakeRoles(store).map((role) => ({ role, status: "planned" as const })),
      };
    }
    // The fence first: legacy writers hold the shared generation lease, so the exclusive lease
    // waits for any in flight and every later legacy write is refused.
    const cutoverAt = existing?.cutoverAt ?? store.now();
    if (existing === null) {
      const before = captureProtocolSelection(layout);
      await withProtocolLayout(
        layout,
        before.protocol,
        () => {
          const paths = protocolPaths(layout);
          const previous =
            management.status === "active" ? (readJsonIfExists(paths.fence) as Json) : null;
          const fence: StoreCutoverFence = {
            cutoverAt,
            generation: previousGeneration + 1,
            kind: "store-cutover",
            previous: previous as StoreCutoverFence["previous"],
            schema: 1,
          };
          writeJsonDurable(paths.fence, fence);
        },
        { exclusive: true, expectedManagement: before.management },
      );
    }
    const report = importLegacy(store, actor, sources, { dryRun: false });
    store.append({
      actor,
      key: `store.cutover:${cutoverAt}`,
      kind: "store.cutover",
      payload: {
        actions: report.counts.actions as unknown as Json,
        cutoverAt,
        generation: previousGeneration + 1,
        imported: report.imported,
        previousGeneration,
      },
    });
    const wakes: { role: string; status: WakeStatus }[] = [];
    for (const role of pendingWakeRoles(store)) {
      // eslint-disable-next-line no-await-in-loop
      const wake = await wakeRecipient(
        {
          env: context.env,
          layout,
          store,
          ...(context.ports === undefined ? {} : { ports: context.ports }),
        },
        role,
      );
      wakes.push({ role, status: wake.status });
    }
    return {
      applied: false,
      cutoverAt,
      dryRun: false,
      fence: { ...fenceView, generation: previousGeneration + 1 },
      import: { counts: report.counts, imported: report.imported, sources: report.sources },
      importedUndelivered: 0,
      kind: "store-cutover",
      schema: 1,
      store: { exists: true, path },
      wakes,
    };
  } finally {
    store.close();
  }
}
