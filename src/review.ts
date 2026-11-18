// @andornaut/coordination-kit/build/review: the scheduled review seam. A resident runner decides when
// a slot is due; this module composes the brief, inventories inboxes and delivers to the route's
// recipient. It never decides cadence and never starts a runner.
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
  type SeamStatus,
} from "./review/outcome.ts";
export {
  DEFERRED_PREFIX,
  deliverScheduledReview,
  type ReviewOptions,
  type ReviewOutcome,
  reviewOutcome,
} from "./review/wake.ts";
