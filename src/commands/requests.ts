// `request close`: the owner of an imported ledger request closes it, optionally naming the work
// item that now carries it. Prints one JSON object; a refusal prints `coordination-kit: CODE`.
import type { Handler } from "../core/io.ts";
import { resolveCaller } from "../store/identity.ts";
import { closeRequest } from "../store/requests.ts";
import { registry, withStore } from "../store/service.ts";
import { callerOf, required, run, text } from "./store.ts";

export const REQUEST_CLOSE_OPTIONS = {
  id: { type: "string" },
  "native-id": { type: "string" },
  reason: { type: "string" },
  work: { type: "string" },
  worker: { type: "string" },
} as const;

export const requestClose: Handler = (io, root, args) =>
  run(
    io,
    root,
    "request close",
    args,
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
    REQUEST_CLOSE_OPTIONS,
  );
