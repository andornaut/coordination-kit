// @andornaut/coordination-kit/build/store: the SQLite coordination store, its message lifecycle,
// wakes, the registry writer fence, runner event ingest, the retirement, imported requests, work
// records, and questions, holds and decisions.
export type { StoreServiceContext } from "./store/context.ts";
export type { AppendResult, VerifyResult } from "./store/db.ts";
export { Store, STORE_FILE, type StoreContext, storePath, storeRoot } from "./store/db.ts";
export { type CodexQuestion, dependentQuestions } from "./store/decisions/codexQuestions.ts";
export {
  appendDecisionLine,
  decisionLine,
  type DecisionLineInput,
  fileDecisionNumbers,
  mainWorkFile,
  type WorkFileTarget,
} from "./store/decisions/decisionLine.ts";
export {
  activePolicyHoldsForRole,
  HOLD_STATES,
  type HoldState,
  type HoldView,
  type PolicyHoldAuthority,
  type PolicyHoldInput,
  type PolicyHoldTarget,
  policyHoldTarget,
  type PolicyHoldView,
  policyTargetCoversRole,
  releasePolicyHold,
  setPolicyHold,
} from "./store/decisions/policyHolds.ts";
export {
  type AnswerInput,
  answerQuestion,
  type AnswerResult,
  cancelQuestion,
  type CoveringHold,
  type DecisionRow,
  type HoldCover,
  type HoldLookup,
  type HoldResult,
  holdScope,
  importedHolds,
  listDecisions,
  listHolds,
  listQuestions,
  normalizeOptions,
  type OpenInput,
  openQuestion,
  publicText,
  QUESTION_STATES,
  questionHoldGuard,
  type QuestionOption,
  type QuestionResult,
  type QuestionState,
  type QuestionView,
  RECORD_ID,
  releaseHold,
  setHold,
  storeHolds,
} from "./store/decisions/questions.ts";
export {
  type AnswerContext,
  type AnswerOutput,
  type HoldOutput,
  type QuestionOutput,
  storeDecisionList,
  storeHoldList,
  storeHoldRelease,
  storeHoldSet,
  storePolicyHoldRelease,
  storePolicyHoldSet,
  storeQuestionAnswer,
  storeQuestionCancel,
  storeQuestionList,
  storeQuestionOpen,
} from "./store/decisions/questionService.ts";
export { canonicalJson, eventHash } from "./store/eventCodec.ts";
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
export { storeRebuild } from "./store/maintenance/rebuild.ts";
export {
  COORDINATOR_ROLE,
  READ_WITH,
  readLedgerRequests,
  RETIRED_PATHS,
  type RetireOutput,
  storeRetire,
} from "./store/maintenance/retire.ts";
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
} from "./store/messages/messages.ts";
export { derivedId, type Notice, reportsRecipient, storeNotice } from "./store/messages/notices.ts";
export {
  storeDone,
  storeExport,
  storeHistory,
  storeInbox,
  storeRetain,
  storeSend,
  storeStatus,
} from "./store/messages/service.ts";
export {
  NO_STORE_GUARD,
  pendingWakeRoles,
  rearmWake,
  type StoreWakeGuard,
  type WakeContext,
  type WakePorts,
  wakeRecipient,
  type WakeResult,
  wakeState,
  type WakeStatus,
} from "./store/messages/wake.ts";
export { PROJECTIONS } from "./store/projections.ts";
export { DELIVERY_PROJECTION } from "./store/projections/delivery.ts";
export { handoffHoldId, HANDOFFS_PROJECTION } from "./store/projections/handoffs.ts";
export { MESSAGES_PROJECTION } from "./store/projections/messages.ts";
export { QUESTIONS_PROJECTION } from "./store/projections/questions.ts";
export { REQUESTS_PROJECTION } from "./store/projections/requests.ts";
export { WORK_KINDS, WORK_PROJECTION } from "./store/projections/work.ts";
export { SECRET_SHAPES, secretShape } from "./store/secrets.ts";
export {
  activeHandoff,
  HANDOFF_STATES,
  HANDOFF_TRANSITIONS,
  handoffHolds,
  type HandoffResult,
  type HandoffRoleView,
  type HandoffState,
  type HandoffView,
  latestHandoff,
  OPEN_HANDOFF_STATES,
  openHandoff,
  openHandoffsFor,
  readHandoff,
  readyHandoff,
  recordSession,
  setHandoffState,
} from "./store/sessions/handoffs.ts";
export {
  type CallerOptions,
  DELIVERY_KIT_ACTOR,
  DELIVERY_KIT_ROLE,
  NATIVE_ID_VARIABLES,
  resolveCaller,
} from "./store/sessions/identity.ts";
export {
  checkpointPath,
  type HandoffOutput,
  type SessionOutput,
  storeHandoffActive,
  storeHandoffOpen,
  storeHandoffReady,
  storeHandoffShow,
  storeHandoffState,
  storeSessionStart,
} from "./store/sessions/service.ts";
export {
  type Actor,
  type CodexQuestionInput,
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
  type NativeQuestionIdentity,
  type Projection,
  type Retention,
  STORE_SCHEMA,
  type StoredEvent,
  StoreError,
  type WakeGuard,
  type WakeOutcome,
  type WorkRef,
} from "./store/types.ts";
export {
  closeRequest,
  type CloseRequestResult,
  importRequest,
  readRequests,
  type RequestImport,
  type RequestRecord,
} from "./store/work-records/requests.ts";
export {
  blockWork,
  FINISH_STATUSES,
  type FinishInput,
  type FinishStatus,
  finishWork,
  readWorkRecord,
  readWorkRecords,
  readyWork,
  recordEvidence,
  retainWorkItem,
  startWork,
  unblockWork,
  WORK_STAGES,
  type WorkEvidence,
  workHistory,
  type WorkRecord,
  type WorkStage,
  type WorkState,
} from "./store/work-records/work.ts";
