// Projections: tables derived from the events, updated in the append transaction and rebuilt by
// `Store.rebuild`. Each projection lists its tables, their DDL and one applier per event kind.
// Kinds without an applier are stored and chained but project nothing, so a later projection can
// add appliers for existing kinds and pick them up on the next rebuild.
import { QUESTION_CODEX_PROJECTION } from "./projections/codexQuestions.ts";
import { DELIVERY_PROJECTION } from "./projections/delivery.ts";
import { HANDOFFS_PROJECTION } from "./projections/handoffs.ts";
import { MESSAGES_PROJECTION } from "./projections/messages.ts";
import { MESSAGE_WAKE_PROJECTION } from "./projections/messageWake.ts";
import { POLICY_HOLDS_PROJECTION } from "./projections/policyHolds.ts";
import { QUESTION_ANSWERS_PROJECTION, QUESTIONS_PROJECTION } from "./projections/questions.ts";
import { REQUESTS_PROJECTION } from "./projections/requests.ts";
import { WORK_PROJECTION } from "./projections/work.ts";
import { PROJECT_TASKS_PROJECTION } from "./projects/tasks.ts";
import type { Projection } from "./types.ts";

/** Every projection, in apply order. A later phase appends its own here. */
export const PROJECTIONS: readonly Projection[] = [
  MESSAGES_PROJECTION,
  MESSAGE_WAKE_PROJECTION,
  DELIVERY_PROJECTION,
  QUESTIONS_PROJECTION,
  QUESTION_ANSWERS_PROJECTION,
  QUESTION_CODEX_PROJECTION,
  POLICY_HOLDS_PROJECTION,
  WORK_PROJECTION,
  HANDOFFS_PROJECTION,
  REQUESTS_PROJECTION,
  PROJECT_TASKS_PROJECTION,
];

/**
 * Tables of retired projections that an older store may still hold. Rebuild drops them; their
 * events (`reminder.claimed`, `reminder.settled`) stay in the journal and project nothing.
 */
export const RETIRED_TABLES: readonly string[] = [
  "pending_notices",
  "reminder_claims",
  "reminder_originals",
];
