// @andornaut/coordination-kit/build/registry: the typed public registry module.
export {
  type AppEntry,
  type AppLayout,
  appLayout,
  appRoleKeys,
  type GameCoordinatorConfig,
  type GameEntry,
  type GameLayout,
  gameLayout,
  type KitEntry,
  type Layout,
  loadLayout,
  type Permission,
  PERMISSIONS,
  roleKeys,
  type RolePermissions,
  UnknownApp,
  UnknownGame,
  validateGameCoordinatorConfig,
  validateWorkspaceConfig,
  type WorkspaceConfig,
} from "../core/layout.ts";
// CLEANUP (added 2026-11-13): Retain old public symbols until registry readers use the canonical names.
export {
  type GameCoordinatorConfig as GameDevConfig,
  validateGameCoordinatorConfig as validateGameDevConfig,
} from "../core/layout.ts";
export { LockBusy, LockError } from "../core/lock.ts";
export { ValidationError } from "../core/validate.ts";
export { resolveConversation, resolveHarness, resolveRole, UnknownRole } from "./resolve.ts";
export {
  type Activation,
  type Adoption,
  type Harness,
  HARNESSES,
  type Mutable,
  type Operation,
  type Registry,
  type RegistryDraft,
  RegistrySchema,
  type RoleRecord,
  type Transfer,
  TRANSFER_PHASES,
  type TransferPhase,
  validateRegistry,
} from "./schema.ts";
export {
  type HarnessSelection,
  resolveSelectedRoles,
  type RoleSelection,
  selectHarness,
} from "./selection.ts";
export {
  createRegistry,
  readRegistry,
  RegistryExists,
  RegistryMissing,
  RevisionConflict,
  type UpdateOptions,
  updateRegistry,
} from "./store.ts";
