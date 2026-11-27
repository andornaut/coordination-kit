import type { Layout, Permission } from "../core/configuration/layout.ts";
import { resolveConversation } from "./resolve.ts";
import type { Registry } from "./schema.ts";

interface BoundActor {
  readonly role: string | null;
  readonly nativeId: string | null;
  readonly worker?: string;
}

export function hasPermission(
  layout: Layout,
  role: string,
  permission: Permission,
  appId?: string,
): boolean {
  if (appId !== undefined && !Object.hasOwn(layout.config.apps, appId)) {
    return false;
  }
  if (layout.mode === "legacy") {
    return role === "game-coordinator" && layout.config.sharedRoles.includes(role);
  }
  const permissions = layout.config.permissions;
  const grants = permissions && Object.hasOwn(permissions, role) ? permissions[role] : undefined;
  return (
    grants?.workspace.includes(permission) === true ||
    (appId !== undefined &&
      grants !== undefined &&
      Object.hasOwn(grants.apps, appId) &&
      grants.apps[appId]?.includes(permission) === true)
  );
}

/** Check an explicit grant against the current active registry binding. */
export function isPermitted(
  layout: Layout,
  registry: Registry,
  actor: BoundActor,
  permission: Permission,
  appId?: string,
): boolean {
  const { nativeId, role } = actor;
  if (
    role === null ||
    nativeId === null ||
    actor.worker !== undefined ||
    !Object.hasOwn(registry.roles, role)
  ) {
    return false;
  }
  const record = registry.roles[role];
  return (
    record?.ownership === "active" &&
    record.phase !== "held" &&
    record.phase !== "source-held" &&
    resolveConversation(registry, role) === nativeId &&
    hasPermission(layout, role, permission, appId)
  );
}
