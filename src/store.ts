// @andornaut/coordination-kit/build/store: the SQLite coordination store, its message lifecycle,
// wakes, the registry writer fence, the legacy import, runner event ingest and the cutover.
export { COORDINATOR_ROLE, type CutoverOutput, storeCutover } from "./store/cutover.ts";
export type { AppendResult, VerifyResult } from "./store/db.ts";
export {
  canonicalJson,
  eventHash,
  type OpenOptions,
  Store,
  STORE_FILE,
  storePath,
  storeRoot,
} from "./store/db.ts";
export { type CallerOptions, NATIVE_ID_VARIABLES, resolveCaller } from "./store/identity.ts";
export {
  busEventId,
  type BusLine,
  type Cursor,
  CURSOR_FILE,
  EVENT_KINDS,
  EVENT_STATUSES,
  type IngestContext,
  ingestEvents,
  type IngestResult,
  LOG_FILE,
  parseBusLine,
  QUARANTINE_FILE,
  readCursor,
} from "./store/ingest.ts";
export {
  type ImportAction,
  type ImportDiff,
  importLegacy,
  type ImportRecord,
  type ImportReport,
  type LegacySource,
  legacySources,
  mapLegacyRecord,
} from "./store/legacy.ts";
export {
  type CloseInput,
  closeMessage,
  type ExportResult,
  exportSince,
  type HistoryEntry,
  type InboxResult,
  MAX_BODY_BYTES,
  MESSAGE_KINDS,
  messageHistory,
  messageStatus,
  readInbox,
  recipientMessages,
  type RetainInput,
  retainMessage,
  type SendInput,
  sendMessage,
  type SendResult,
  type WriteResult,
} from "./store/messages.ts";
export { isStoreMode, type StoreMode, storeMode, type StoreModeName } from "./store/mode.ts";
export {
  DELIVERY_KIT_ACTOR,
  DELIVERY_KIT_ROLE,
  derivedId,
  type Notice,
  reportsRecipient,
  storeNotice,
} from "./store/notices.ts";
export {
  DELIVERY_PROJECTION,
  MESSAGES_PROJECTION,
  type Projection,
  PROJECTIONS,
} from "./store/projections.ts";
export { SECRET_SHAPES, secretShape } from "./store/secrets.ts";
export {
  storeDone,
  storeExport,
  storeHistory,
  storeImport,
  storeInbox,
  storeRebuild,
  storeRetain,
  storeSend,
  type StoreServiceContext,
  storeStatus,
} from "./store/service.ts";
export {
  type Actor,
  type EventInput,
  GENESIS,
  type Json,
  type JsonObject,
  type LegacyOrigin,
  MESSAGE_STATES,
  type MessageIntent,
  type MessageLink,
  type MessageState,
  type MessageView,
  type Retention,
  STORE_SCHEMA,
  type StoredEvent,
  StoreError,
  type WakeOutcome,
} from "./store/types.ts";
export {
  NO_STORE_GUARD,
  pendingWakeRoles,
  rearmWake,
  type StoreWakeGuard,
  type WakeContext,
  type WakeGuard,
  type WakePorts,
  wakeRecipient,
  type WakeResult,
  wakeState,
  type WakeStatus,
} from "./store/wake.ts";
