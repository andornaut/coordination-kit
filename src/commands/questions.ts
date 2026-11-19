// The question, hold and decision verbs: `question open|answer|cancel|list`, `hold set|release|list`
// and `decision list`. Writes identify the caller through the registry fence and refuse any other
// owner's record. Each prints one JSON object on stdout; a refusal prints `coordination-kit: CODE`
// on stderr and exits 1, and a usage error exits 2.

import type { Handler } from "../io.ts";
import {
  HOLD_STATES,
  type HoldState,
  normalizeOptions,
  QUESTION_STATES,
  type QuestionState,
} from "../store/questions.ts";
import {
  storeDecisionList,
  storeHoldList,
  storeHoldRelease,
  storeHoldSet,
  storeQuestionAnswer,
  storeQuestionCancel,
  storeQuestionList,
  storeQuestionOpen,
} from "../store/questionService.ts";
import { callerOf, required, run, text, Usage, type Values } from "./store.ts";

const CALLER = {
  "native-id": { type: "string" },
  worker: { type: "string" },
} as const;

export const QUESTION_OPEN_OPTIONS = {
  ...CALLER,
  id: { type: "string" },
  option: { multiple: true, type: "string" },
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

export const QUESTION_CANCEL_OPTIONS = {
  ...CALLER,
  id: { type: "string" },
  reason: { type: "string" },
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
      const options = Array.isArray(labels) ? normalizeOptions(labels) : undefined;
      return storeQuestionOpen(context, callerOf(values), {
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
