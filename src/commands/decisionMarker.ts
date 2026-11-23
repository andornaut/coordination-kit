import type { Handler } from "../io.ts";
import { ownerDecisionMarker, resolveOwnerDecision } from "../store/decisionMarkerService.ts";
import { required, run, Usage } from "./store.ts";

export const DECISION_MARKER_OPTIONS = {} as const;
export const DECISION_RESOLVE_OPTIONS = {
  "answer-item": { type: "string" },
  "answer-turn": { type: "string" },
  expect: { type: "string" },
  "expect-revision": { type: "string" },
  "question-item": { type: "string" },
  "question-turn": { type: "string" },
} as const;

export const decisionMarker: Handler = (io, root, args) =>
  run(io, root, "decision marker", args, ownerDecisionMarker, DECISION_MARKER_OPTIONS);

export const decisionResolve: Handler = (io, root, args) =>
  run(
    io,
    root,
    "decision resolve",
    args,
    (context, values) => {
      const revision = required(values, "expect-revision");
      if (!/^[1-9]\d*$/.test(revision)) {
        throw new Usage();
      }
      return resolveOwnerDecision(context, {
        digest: required(values, "expect"),
        resolution: {
          answer_item_id: required(values, "answer-item"),
          answer_turn_id: required(values, "answer-turn"),
          question_item_id: required(values, "question-item"),
          question_turn_id: required(values, "question-turn"),
        },
        revision: Number(revision),
      });
    },
    DECISION_RESOLVE_OPTIONS,
  );
