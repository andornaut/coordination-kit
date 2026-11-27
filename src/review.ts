// @andornaut/coordination-kit/build/review: the scheduled review seam. A resident runner decides when
// a slot is due; this module stores the brief as a message to the route's recipient and wakes it.
// It never decides cadence and never starts a runner.
export {
  readRoleRoute,
  type RoleRoute,
  ROUTE_SCHEMA_1,
  RouteError,
  routeRecipient,
  validateRoleRoute,
} from "./adapters/shared/route.ts";
export {
  type CliIdentity,
  REASON_TOKENS,
  type ReasonToken,
  type ReviewResult,
  type SeamStatus,
} from "./core/cli/outcome.ts";
export { deliverReview, type ReviewOptions } from "./review/deliver.ts";
export { coordinationEmit, coordinationNotice } from "./review/emit.ts";
export {
  BRIEF_MAX_BYTES,
  BRIEF_MAX_LINES,
  type BriefException,
  type BriefRecord,
  composeBrief,
  showBrief,
  storeReview,
} from "./review/storeBrief.ts";
export {
  type NativeCollect,
  type NativeQuestion,
  type NativeSurvey,
  type NativeWorker,
  surveyNative,
} from "./review/storeNative.ts";
