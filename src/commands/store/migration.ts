import type { Handler } from "../../core/cli/io.ts";
import { systemGit } from "../../core/git.ts";
import { registry, type StoreServiceContext } from "../../store/context.ts";
import { storePath } from "../../store/db.ts";
import { inspectFileAuthority } from "../../store/files/authority.ts";
import { activateMigration, prepareMigration } from "../../store/files/migration.ts";
import { resolveCaller } from "../../store/sessions/identity.ts";
import { requirePermission } from "../../store/sessions/permissions.ts";
import { callerOf, required } from "../args.ts";
import { storeVerb } from "./context.ts";

const NATIVE_ID = { "native-id": { type: "string" } } as const;

export const MIGRATION_STATUS_OPTIONS = {} as const;
export const MIGRATION_PREPARE_OPTIONS = {
  ...NATIVE_ID,
  backup: { type: "string" },
  restore: { type: "string" },
} as const;
export const MIGRATION_ACTIVATE_OPTIONS = {
  ...NATIVE_ID,
  id: { type: "string" },
} as const;

function verifyMaintainer(
  context: StoreServiceContext,
  options: ReturnType<typeof callerOf>,
): void {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  requirePermission(context.layout, roles, actor, "store:maintain");
}

export const migrationStatus: Handler = storeVerb(
  "store migration-status",
  MIGRATION_STATUS_OPTIONS,
  ({ env, layout }) => {
    const { kind, receipt } = inspectFileAuthority(systemGit(env), layout, storePath(layout));
    return { authority: kind, receipt: receipt ?? null, schema: 1 };
  },
);

export const migrationPrepare: Handler = storeVerb(
  "store migration-prepare",
  MIGRATION_PREPARE_OPTIONS,
  (context, values) => {
    verifyMaintainer(context, callerOf(values));
    return {
      ...prepareMigration(
        systemGit(context.env),
        context.layout,
        required(values, "backup"),
        required(values, "restore"),
      ),
      schema: 1,
    };
  },
);

export const migrationActivate: Handler = storeVerb(
  "store migration-activate",
  MIGRATION_ACTIVATE_OPTIONS,
  (context, values) => {
    verifyMaintainer(context, callerOf(values));
    return {
      receipt: activateMigration(systemGit(context.env), context.layout, required(values, "id")),
      schema: 1,
    };
  },
);
