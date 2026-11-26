import type { Layout, Permission } from "../core/layout.ts";
import { isPermitted } from "../registry/permissions.ts";
import type { Registry } from "../registry/schema.ts";
import { type Actor, StoreError } from "./types.ts";

export function requirePermission(
  layout: Layout,
  registry: Registry,
  actor: Actor,
  permission: Permission,
  appId?: string,
): void {
  if (!isPermitted(layout, registry, actor, permission, appId)) {
    throw new StoreError(layout.mode === "legacy" ? "not-coordinator" : "permission-denied");
  }
}
