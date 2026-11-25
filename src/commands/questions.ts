// The question, hold and decision verbs: `question open|answer|project|cancel|close-legacy|list`,
// `hold set|release|list` and `decision list`. Writes identify the caller through the registry
// fence and refuse any other owner's record. Each prints one JSON object on stdout; a refusal
// prints `coordination-kit: CODE` on stderr and exits 1, and a usage error exits 2.

import type { Handler } from "../io.ts";
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
  storeQuestionAttach,
  storeQuestionCancel,
  storeQuestionCloseLegacy,
  storeQuestionList,
  storeQuestionOpen,
  storeQuestionProject,
  storeQuestionReask,
  storeQuestionReconcile,
} from "../store/questionService.ts";
import { parseWorkRef } from "../work/live.ts";
import { callerOf, required, run, text, Usage, type Values } from "./store.ts";

const CALLER = {
  "native-id": { type: "string" },
  worker: { type: "string" },
} as const;

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
export const QUESTION_ATTACH_OPTIONS = {
  ...QUESTION_PROJECT_OPTIONS,
  index: { type: "string" },
  item: { type: "string" },
  turn: { type: "string" },
} as const;

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

export const questionOpen: Handler = (io, root, args) =>
  run(
    io,
    root,
    "question open",
    args,
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
    QUESTION_OPEN_OPTIONS,
  );

export const questionAnswer: Handler = (io, root, args) =>
  run(
    io,
    root,
    "question answer",
    args,
    (context, values) =>
      storeQuestionAnswer(context, callerOf(values), required(values, "id"), {
        text: required(values, "text"),
        work: required(values, "work"),
        ...optional("by", text(values, "by")),
        ...optional("supersedes", text(values, "supersedes")),
      }),
    QUESTION_ANSWER_OPTIONS,
  );

export const questionProject: Handler = (io, root, args) =>
  run(
    io,
    root,
    "question project",
    args,
    (context, values) => storeQuestionProject(context, callerOf(values), required(values, "id")),
    QUESTION_PROJECT_OPTIONS,
  );

export const questionAttach: Handler = (io, root, args) =>
  run(
    io,
    root,
    "question attach",
    args,
    (context, values) =>
      storeQuestionAttach(context, callerOf(values), required(values, "id"), {
        index: Number(required(values, "index")),
        item: required(values, "item"),
        turn: required(values, "turn"),
      }),
    QUESTION_ATTACH_OPTIONS,
  );

export const questionReconcile: Handler = (io, root, args) =>
  run(
    io,
    root,
    "question reconcile",
    args,
    (context, values) => storeQuestionReconcile(context, callerOf(values), required(values, "id")),
    QUESTION_PROJECT_OPTIONS,
  );

export const questionReask: Handler = (io, root, args) =>
  run(
    io,
    root,
    "question reask",
    args,
    (context, values) => storeQuestionReask(context, callerOf(values), required(values, "id")),
    QUESTION_PROJECT_OPTIONS,
  );

export const questionCancel: Handler = (io, root, args) =>
  run(
    io,
    root,
    "question cancel",
    args,
    (context, values) =>
      storeQuestionCancel(
        context,
        callerOf(values),
        required(values, "id"),
        required(values, "reason"),
      ),
    QUESTION_CANCEL_OPTIONS,
  );

/** CLEANUP (added 2026-11-25): see `closeLegacyQuestion`. */
export const questionCloseLegacy: Handler = (io, root, args) =>
  run(
    io,
    root,
    "question close-legacy",
    args,
    (context, values) =>
      storeQuestionCloseLegacy(context, callerOf(values), {
        approval: required(values, "approval"),
        id: required(values, "id"),
        reason: required(values, "reason"),
      }),
    QUESTION_CLOSE_LEGACY_OPTIONS,
  );

export const questionList: Handler = (io, root, args) =>
  run(
    io,
    root,
    "question list",
    args,
    (context, values) => {
      const states = state<QuestionState>(values, QUESTION_STATES);
      return storeQuestionList(context, {
        ...optional("role", text(values, "role")),
        ...(states === undefined ? {} : { states }),
      });
    },
    QUESTION_LIST_OPTIONS,
  );

export const holdSet: Handler = (io, root, args) =>
  run(
    io,
    root,
    "hold set",
    args,
    (context, values) =>
      storeHoldSet(context, callerOf(values), {
        id: required(values, "id"),
        reason: required(values, "reason"),
        scope: required(values, "scope"),
      }),
    HOLD_SET_OPTIONS,
  );

export const holdRelease: Handler = (io, root, args) =>
  run(
    io,
    root,
    "hold release",
    args,
    (context, values) => storeHoldRelease(context, callerOf(values), required(values, "id")),
    HOLD_RELEASE_OPTIONS,
  );

export const policyHoldSet: Handler = (io, root, args) =>
  run(
    io,
    root,
    "hold policy-set",
    args,
    (context, values) =>
      storePolicyHoldSet(context, callerOf(values), {
        approval: required(values, "approval"),
        id: required(values, "id"),
        reason: required(values, "reason"),
        scope: required(values, "scope"),
      }),
    POLICY_HOLD_SET_OPTIONS,
  );

export const policyHoldRelease: Handler = (io, root, args) =>
  run(
    io,
    root,
    "hold policy-release",
    args,
    (context, values) =>
      storePolicyHoldRelease(context, callerOf(values), {
        approval: required(values, "approval"),
        id: required(values, "id"),
      }),
    POLICY_HOLD_RELEASE_OPTIONS,
  );

export const holdList: Handler = (io, root, args) =>
  run(
    io,
    root,
    "hold list",
    args,
    (context, values) => {
      const states = state<HoldState>(values, HOLD_STATES);
      return storeHoldList(context, {
        ...optional("role", text(values, "role")),
        ...(states === undefined ? {} : { states }),
      });
    },
    HOLD_LIST_OPTIONS,
  );

export const decisionList: Handler = (io, root, args) =>
  run(
    io,
    root,
    "decision list",
    args,
    (context, values) =>
      storeDecisionList(context, {
        ...optional("role", text(values, "role")),
        ...optional("work", text(values, "work")),
      }),
    DECISION_LIST_OPTIONS,
  );
