import type { Handler } from "../io.ts";
import { storePath } from "../store/db.ts";
import { inspectFileAuthority } from "../store/files/authority.ts";
import { activateMigration, prepareMigration } from "../store/files/migration.ts";
import { resolveCaller } from "../store/identity.ts";
import { registry, type StoreServiceContext } from "../store/service.ts";
import { StoreError } from "../store/types.ts";
import { callerOf, required, run } from "./store.ts";

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

function verifyCoordinator(
  context: StoreServiceContext,
  options: ReturnType<typeof callerOf>,
): void {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  if (actor.role !== "game-coordinator" || roles.roles[actor.role]?.ownership !== "active") {
    throw new StoreError("not-coordinator");
  }
}

export const migrationStatus: Handler = (io, root, args) =>
  run(
    io,
    root,
    "store migration-status",
    args,
    ({ layout }) => {
      const { kind, receipt } = inspectFileAuthority(layout, storePath(layout));
      return { authority: kind, receipt: receipt ?? null, schema: 1 };
    },
    MIGRATION_STATUS_OPTIONS,
  );

export const migrationPrepare: Handler = (io, root, args) =>
  run(
    io,
    root,
    "store migration-prepare",
    args,
    (context, values) => {
      verifyCoordinator(context, callerOf(values));
      return {
        ...prepareMigration(
          context.layout,
          required(values, "backup"),
          required(values, "restore"),
        ),
        schema: 1,
      };
    },
    MIGRATION_PREPARE_OPTIONS,
  );

export const migrationActivate: Handler = (io, root, args) =>
  run(
    io,
    root,
    "store migration-activate",
    args,
    (context, values) => {
      verifyCoordinator(context, callerOf(values));
      return { receipt: activateMigration(context.layout, required(values, "id")), schema: 1 };
    },
    MIGRATION_ACTIVATE_OPTIONS,
  );
