// The question, hold and decision verbs: `question open|answer|project|cancel|close-legacy|list`,
// `hold set|release|list` and `decision list`. Writes identify the caller through the registry
// fence and refuse any other owner's record. Each prints one JSON object on stdout; a refusal
// prints `coordination-kit: CODE` on stderr and exits 1, and a usage error exits 2.

import { hostname } from "node:os";

import type { Handler } from "../core/io.ts";
import { HOLD_STATES, type HoldState } from "../store/policyHolds.ts";
import { normalizeOptions, QUESTION_STATES, type QuestionState } from "../store/questions.ts";
import {
  storeDecisionList,
  storeHoldList,
  storeHoldRelease,
  storeHoldSet,
  storePolicyHoldRelease,
  storePolicyHoldSet,
  storeQuestionAnswer,
  storeQuestionCancel,
  storeQuestionCloseLegacy,
  storeQuestionList,
  storeQuestionOpen,
  storeQuestionProject,
  storeQuestionReconcile,
} from "../store/questionService.ts";
import { parseWorkRef } from "../work/live.ts";
import { CALLER, callerOf, required, text, Usage, type Values } from "./args.ts";
import { storeVerb } from "./store.ts";

export const QUESTION_OPEN_OPTIONS = {
  ...CALLER,
  "depends-on": { multiple: true, type: "string" },
  id: { type: "string" },
  option: { multiple: true, type: "string" },
  "option-json": { multiple: true, type: "string" },
  title: { type: "string" },
  work: { type: "string" },
} as const;

export const QUESTION_ANSWER_OPTIONS = {
  ...CALLER,
  by: { type: "string" },
  id: { type: "string" },
  supersedes: { type: "string" },
  text: { type: "string" },
  work: { type: "string" },
} as const;

export const QUESTION_PROJECT_OPTIONS = { ...CALLER, id: { type: "string" } } as const;

export const QUESTION_CANCEL_OPTIONS = {
  ...CALLER,
  id: { type: "string" },
  reason: { type: "string" },
} as const;

/** CLEANUP (added 2026-11-25): see `closeLegacyQuestion`. */
export const QUESTION_CLOSE_LEGACY_OPTIONS = {
  ...QUESTION_CANCEL_OPTIONS,
  approval: { type: "string" },
} as const;

export const QUESTION_LIST_OPTIONS = {
  role: { type: "string" },
  state: { type: "string" },
} as const;

export const HOLD_SET_OPTIONS = {
  ...CALLER,
  id: { type: "string" },
  reason: { type: "string" },
  scope: { type: "string" },
} as const;

export const HOLD_RELEASE_OPTIONS = { ...CALLER, id: { type: "string" } } as const;

export const POLICY_HOLD_RELEASE_OPTIONS = {
  ...CALLER,
  approval: { type: "string" },
  id: { type: "string" },
} as const;

export const POLICY_HOLD_SET_OPTIONS = {
  ...POLICY_HOLD_RELEASE_OPTIONS,
  reason: { type: "string" },
  scope: { type: "string" },
} as const;

export const HOLD_LIST_OPTIONS = QUESTION_LIST_OPTIONS;

export const DECISION_LIST_OPTIONS = {
  role: { type: "string" },
  work: { type: "string" },
} as const;

function state<T extends string>(values: Values, states: readonly T[]): T[] | undefined {
  const value = text(values, "state");
  if (value === undefined) {
    return undefined;
  }
  if (!(states as readonly string[]).includes(value)) {
    throw new Usage();
  }
  return [value as T];
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

export const questionOpen: Handler = storeVerb(
  "question open",
  QUESTION_OPEN_OPTIONS,
  (context, values) => {
    const labels = values.option;
    const descriptions = values["option-json"];
    const dependencies = values["depends-on"];
    if (labels !== undefined && descriptions !== undefined) {
      throw new Usage();
    }
    let entries: unknown = labels;
    if (Array.isArray(descriptions)) {
      try {
        entries = descriptions.map((entry) => JSON.parse(entry) as unknown);
      } catch {
        throw new Usage();
      }
    }
    const options = entries === undefined ? undefined : normalizeOptions(entries);
    return storeQuestionOpen(context, callerOf(values), {
      ...(Array.isArray(dependencies) ? { dependsOn: dependencies.map(parseWorkRef) } : {}),
      title: required(values, "title"),
      ...optional("id", text(values, "id")),
      ...optional("work", text(values, "work")),
      ...(options === undefined ? {} : { options }),
    });
  },
);

export const questionAnswer: Handler = storeVerb(
  "question answer",
  QUESTION_ANSWER_OPTIONS,
  (context, values) =>
    storeQuestionAnswer(
      { ...context, hostname: hostname() },
      callerOf(values),
      required(values, "id"),
      {
        text: required(values, "text"),
        work: required(values, "work"),
        ...optional("by", text(values, "by")),
        ...optional("supersedes", text(values, "supersedes")),
      },
    ),
);

export const questionProject: Handler = storeVerb(
  "question project",
  QUESTION_PROJECT_OPTIONS,
  (context, values) =>
    storeQuestionProject(
      { ...context, hostname: hostname() },
      callerOf(values),
      required(values, "id"),
    ),
);

export const questionReconcile: Handler = storeVerb(
  "question reconcile",
  QUESTION_PROJECT_OPTIONS,
  (context, values) => storeQuestionReconcile(context, callerOf(values), required(values, "id")),
);

export const questionCancel: Handler = storeVerb(
  "question cancel",
  QUESTION_CANCEL_OPTIONS,
  (context, values) =>
    storeQuestionCancel(
      context,
      callerOf(values),
      required(values, "id"),
      required(values, "reason"),
    ),
);

/** CLEANUP (added 2026-11-25): see `closeLegacyQuestion`. */
export const questionCloseLegacy: Handler = storeVerb(
  "question close-legacy",
  QUESTION_CLOSE_LEGACY_OPTIONS,
  (context, values) =>
    storeQuestionCloseLegacy(context, callerOf(values), {
      approval: required(values, "approval"),
      id: required(values, "id"),
      reason: required(values, "reason"),
    }),
);

export const questionList: Handler = storeVerb(
  "question list",
  QUESTION_LIST_OPTIONS,
  (context, values) => {
    const states = state<QuestionState>(values, QUESTION_STATES);
    return storeQuestionList(context, {
      ...optional("role", text(values, "role")),
      ...(states === undefined ? {} : { states }),
    });
  },
);

export const holdSet: Handler = storeVerb("hold set", HOLD_SET_OPTIONS, (context, values) =>
  storeHoldSet(context, callerOf(values), {
    id: required(values, "id"),
    reason: required(values, "reason"),
    scope: required(values, "scope"),
  }),
);

export const holdRelease: Handler = storeVerb(
  "hold release",
  HOLD_RELEASE_OPTIONS,
  (context, values) => storeHoldRelease(context, callerOf(values), required(values, "id")),
);

export const policyHoldSet: Handler = storeVerb(
  "hold policy-set",
  POLICY_HOLD_SET_OPTIONS,
  (context, values) =>
    storePolicyHoldSet(context, callerOf(values), {
      approval: required(values, "approval"),
      id: required(values, "id"),
      reason: required(values, "reason"),
      scope: required(values, "scope"),
    }),
);

export const policyHoldRelease: Handler = storeVerb(
  "hold policy-release",
  POLICY_HOLD_RELEASE_OPTIONS,
  (context, values) =>
    storePolicyHoldRelease(context, callerOf(values), {
      approval: required(values, "approval"),
      id: required(values, "id"),
    }),
);

export const holdList: Handler = storeVerb("hold list", HOLD_LIST_OPTIONS, (context, values) => {
  const states = state<HoldState>(values, HOLD_STATES);
  return storeHoldList(context, {
    ...optional("role", text(values, "role")),
    ...(states === undefined ? {} : { states }),
  });
});

export const decisionList: Handler = storeVerb(
  "decision list",
  DECISION_LIST_OPTIONS,
  (context, values) =>
    storeDecisionList(context, {
      ...optional("role", text(values, "role")),
      ...optional("work", text(values, "work")),
    }),
);
