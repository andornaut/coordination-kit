import { resolve } from "node:path";

import type { Handler } from "../../core/cli/io.ts";
import { systemGit } from "../../core/git.ts";
import { registry } from "../../store/context.ts";
import { Store } from "../../store/db.ts";
import { planFileCompaction } from "../../store/files/compaction/plan.ts";
import { storeRebuild } from "../../store/maintenance/rebuild.ts";
import { storeRetire } from "../../store/maintenance/retire.ts";
import { storeExport } from "../../store/messages/service.ts";
import { StoreError } from "../../store/types.ts";
import { importApprovalLedger } from "../../work/approvals.ts";
import { CALLER, callerOf, isoInstant, required, Usage } from "../args.ts";
import { storeVerb } from "./context.ts";

export const STORE_IMPORT_OPTIONS = {
  ...CALLER,
  "approval-ledger": { type: "string" },
  "dry-run": { type: "boolean" },
} as const;

export const STORE_EXPORT_OPTIONS = { ...CALLER, since: { type: "string" } } as const;

export const STORE_REBUILD_OPTIONS = CALLER;
export const STORE_COMPACTION_PLAN_OPTIONS = {} as const;

export const STORE_RETIRE_OPTIONS = {
  ...CALLER,
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
} as const;

export const storeImportCommand: Handler = storeVerb(
  "store import",
  STORE_IMPORT_OPTIONS,
  (context, values) => {
    const ledger = required(values, "approval-ledger");
    return importApprovalLedger(
      {
        clock: context.clock,
        coordinatorRoot: context.layout.root,
        env: context.env,
        git: systemGit(context.env),
      },
      callerOf(values),
      { dryRun: values["dry-run"] === true, file: resolve(context.cwd, ledger) },
    );
  },
);

export const storeExportCommand: Handler = storeVerb(
  "store export",
  STORE_EXPORT_OPTIONS,
  (context, values) =>
    storeExport(context, isoInstant(required(values, "since")), callerOf(values)),
);

export const storeRebuildCommand: Handler = storeVerb(
  "store rebuild",
  STORE_REBUILD_OPTIONS,
  (context, values) => storeRebuild(context, callerOf(values)),
);

export const storeCompactionPlanCommand: Handler = storeVerb(
  "store compaction-plan",
  STORE_COMPACTION_PLAN_OPTIONS,
  (context) => {
    const { revision, roles } = registry(context);
    const store = Store.readLayout(context, context.layout);
    try {
      if (!store?.fileBacked) {
        throw new StoreError("compaction-file-authority-required");
      }
      const events = store.events();
      if (registry(context).revision !== revision) {
        throw new StoreError("compaction-registry-changed");
      }
      return planFileCompaction(
        events,
        {
          registeredGames: new Set(Object.keys(context.layout.config.games)),
          registeredRoles: new Set(Object.keys(roles)),
          registryRevision: revision,
        },
        store.compactedEventSequences(),
      );
    } finally {
      store?.close();
    }
  },
);

export const storeRetireCommand: Handler = storeVerb(
  "store retire",
  STORE_RETIRE_OPTIONS,
  (context, values) => {
    if ((values.apply === true) === (values["dry-run"] === true)) {
      throw new Usage();
    }
    if (values["dry-run"] === true && (values["native-id"] ?? values.worker) !== undefined) {
      throw new Usage();
    }
    return storeRetire(context, callerOf(values), { apply: values.apply === true });
  },
);
