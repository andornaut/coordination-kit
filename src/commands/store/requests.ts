// `request close`: the owner of an imported ledger request closes it, optionally naming the work
// item that now carries it. Prints one JSON object; a refusal prints `coordination-kit: CODE`.
import type { Handler } from "../../core/cli/io.ts";
import { registry, withStore } from "../../store/context.ts";
import { resolveCaller } from "../../store/sessions/identity.ts";
import { closeRequest } from "../../store/work-records/requests.ts";
import { callerOf, required, text } from "../args.ts";
import { storeVerb } from "./context.ts";

export const REQUEST_CLOSE_OPTIONS = {
  id: { type: "string" },
  "native-id": { type: "string" },
  reason: { type: "string" },
  work: { type: "string" },
  worker: { type: "string" },
} as const;

export const requestClose: Handler = storeVerb(
  "request close",
  REQUEST_CLOSE_OPTIONS,
  (context, values) => {
    const id = required(values, "id");
    const reason = required(values, "reason");
    const work = text(values, "work");
    const actor = resolveCaller(registry(context), context.env, callerOf(values));
    return withStore(context, (store) => ({
      schema: 1,
      ...closeRequest(store, actor, { id, reason, ...(work === undefined ? {} : { work }) }),
    }));
  },
);
