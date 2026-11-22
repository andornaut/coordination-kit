import type { Handler } from "../io.ts";
import type { ReminderOutcome } from "../store/reminders.ts";
import {
  storeReminderCheck,
  storeReminderClaim,
  storeReminderList,
  storeReminderSettle,
} from "../store/reminderService.ts";
import { callerOf, required, run, Usage } from "./store.ts";

const CALLER = { "native-id": { type: "string" } } as const;

export const REMINDER_LIST_OPTIONS = {} as const;
export const REMINDER_CLAIM_OPTIONS = {
  ...CALLER,
  original: { multiple: true, type: "string" },
  role: { type: "string" },
} as const;
export const REMINDER_CHECK_OPTIONS = { ...CALLER, id: { type: "string" } } as const;
export const REMINDER_SETTLE_OPTIONS = {
  ...REMINDER_CHECK_OPTIONS,
  outcome: { type: "string" },
  reason: { type: "string" },
} as const;

export const reminderList: Handler = (io, root, args) =>
  run(io, root, "reminder list", args, storeReminderList, REMINDER_LIST_OPTIONS);

export const reminderClaim: Handler = (io, root, args) =>
  run(
    io,
    root,
    "reminder claim",
    args,
    (context, values) => {
      const originals = values.original;
      if (!Array.isArray(originals)) {
        throw new Usage();
      }
      return storeReminderClaim(context, callerOf(values), {
        originals,
        role: required(values, "role"),
      });
    },
    REMINDER_CLAIM_OPTIONS,
  );

export const reminderCheck: Handler = (io, root, args) =>
  run(
    io,
    root,
    "reminder check",
    args,
    (context, values) => storeReminderCheck(context, callerOf(values), required(values, "id")),
    REMINDER_CHECK_OPTIONS,
  );

export const reminderSettle: Handler = (io, root, args) =>
  run(
    io,
    root,
    "reminder settle",
    args,
    (context, values) =>
      storeReminderSettle(context, callerOf(values), {
        id: required(values, "id"),
        outcome: required(values, "outcome") as ReminderOutcome,
        reason: required(values, "reason"),
      }),
    REMINDER_SETTLE_OPTIONS,
  );
