// `session start` and `handoff open|ready|state|active|show`. Writers identify the caller through
// the registry fence. Each prints one JSON object on stdout; a refusal prints
// `coordination-kit: CODE` on stderr and exits 1, and a usage error exits 2.
import type { Handler } from "../core/io.ts";
import { VERSION } from "../core/version.ts";
import { type Harness, HARNESSES } from "../registry/schema.ts";
import type { HandoffState } from "../store/handoffs.ts";
import {
  storeHandoffActive,
  storeHandoffOpen,
  storeHandoffReady,
  storeHandoffShow,
  storeHandoffState,
  storeSessionStart,
} from "../store/sessionService.ts";
import { CALLER, callerOf, required, text, Usage } from "./args.ts";
import { run } from "./store.ts";

export const SESSION_START_OPTIONS = CALLER;
export const HANDOFF_OPEN_OPTIONS = {
  ...CALLER,
  id: { type: "string" },
  scope: { multiple: true, type: "string" },
  to: { type: "string" },
} as const;
export const HANDOFF_ROLE_OPTIONS = { ...CALLER, id: { type: "string" } } as const;
export const HANDOFF_STATE_OPTIONS = { ...CALLER, id: { type: "string" } } as const;
export const HANDOFF_SHOW_OPTIONS = { id: { type: "string" } } as const;

const SETTABLE: readonly HandoffState[] = ["prepared", "sent", "completed", "cancelled"];

function id(value: string | undefined): { id?: string } {
  return value === undefined ? {} : { id: value };
}

export const sessionStart: Handler = (io, root, args) =>
  run(
    io,
    root,
    "session start",
    args,
    (context, values) =>
      storeSessionStart(context, callerOf(values), { cwd: io.cwd, version: VERSION }),
    SESSION_START_OPTIONS,
  );

export const handoffOpen: Handler = (io, root, args) =>
  run(
    io,
    root,
    "handoff open",
    args,
    (context, values) => {
      const to = required(values, "to");
      const scope = (values.scope as string[] | undefined) ?? [];
      if (!(HARNESSES as readonly string[]).includes(to) || scope.length === 0) {
        throw new Usage();
      }
      return storeHandoffOpen(context, callerOf(values), {
        scope,
        to: to as Harness,
        ...id(text(values, "id")),
      });
    },
    HANDOFF_OPEN_OPTIONS,
  );

export const handoffReady: Handler = (io, root, args) =>
  run(
    io,
    root,
    "handoff ready",
    args,
    (context, values) => storeHandoffReady(context, callerOf(values), id(text(values, "id"))),
    HANDOFF_ROLE_OPTIONS,
  );

export const handoffActive: Handler = (io, root, args) =>
  run(
    io,
    root,
    "handoff active",
    args,
    (context, values) => storeHandoffActive(context, callerOf(values), id(text(values, "id"))),
    HANDOFF_ROLE_OPTIONS,
  );

export const handoffState: Handler = (io, root, args) =>
  run(
    io,
    root,
    "handoff state",
    args,
    (context, values, positionals) => {
      const [state] = positionals;
      if (positionals.length !== 1 || !(SETTABLE as readonly string[]).includes(state!)) {
        throw new Usage();
      }
      return storeHandoffState(context, callerOf(values), {
        id: required(values, "id"),
        state: state as HandoffState,
      });
    },
    HANDOFF_STATE_OPTIONS,
    1,
  );

export const handoffShow: Handler = (io, root, args) =>
  run(
    io,
    root,
    "handoff show",
    args,
    (context, values) => storeHandoffShow(context, id(text(values, "id"))),
    HANDOFF_SHOW_OPTIONS,
  );
