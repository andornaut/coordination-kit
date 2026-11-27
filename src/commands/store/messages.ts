import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Handler } from "../../core/cli/io.ts";
import { NEXT_REVIEW_BOUNDARY, retentionInstant } from "../../store/messages/retention.ts";
import {
  storeDone,
  storeHistory,
  storeInbox,
  storeInboxPeek,
  storeMessageDecide,
  storeRetain,
  storeSend,
  storeStatus,
} from "../../store/messages/service.ts";
import { type MessageLink, StoreError } from "../../store/types.ts";
import { CALLER, callerOf, isoInstant, required, text, Usage, type Values } from "../args.ts";
import { storeVerb } from "./context.ts";

export const MSG_SEND_OPTIONS = {
  ...CALLER,
  body: { type: "string" },
  "body-file": { type: "string" },
  id: { type: "string" },
  intent: { type: "string" },
  link: { multiple: true, type: "string" },
  to: { type: "string" },
} as const;

export const MSG_DONE_OPTIONS = {
  ...CALLER,
  evidence: { multiple: true, type: "string" },
  "superseded-by": { type: "string" },
  work: { type: "string" },
} as const;

export const MSG_DECIDE_OPTIONS = {
  ...CALLER,
  approve: { type: "boolean" },
  "body-sha256": { type: "string" },
  decline: { type: "boolean" },
  prompt: { type: "string" },
  scope: { type: "string" },
  "user-reply": { type: "string" },
} as const;

export const MSG_RETAIN_OPTIONS = {
  ...CALLER,
  evidence: MSG_DONE_OPTIONS.evidence,
  "next-boundary": { type: "string" },
  "next-review": { type: "boolean" },
  owner: { type: "string" },
  reason: { type: "string" },
  until: { type: "string" },
} as const;

export const MSG_STATUS_OPTIONS = {
  ...CALLER,
  "include-body": { type: "boolean" },
} as const;

export const MSG_HISTORY_OPTIONS = {
  ...CALLER,
  "include-body": { type: "boolean" },
  limit: { type: "string" },
  role: { type: "string" },
  since: { type: "string" },
} as const;

export const INBOX_OPTIONS = {
  ...CALLER,
  all: { type: "boolean" },
  "include-body": { type: "boolean" },
  peek: { type: "boolean" },
} as const;

function links(values: Values): MessageLink[] {
  return ((values.link as string[] | undefined) ?? []).map((value) => {
    const at = value.indexOf("=");
    if (at <= 0 || at === value.length - 1) {
      throw new Usage();
    }
    return { kind: value.slice(0, at), ref: value.slice(at + 1) };
  });
}

export const msgSend: Handler = storeVerb("msg send", MSG_SEND_OPTIONS, (context, values) => {
  const file = text(values, "body-file");
  const inline = text(values, "body");
  const intent = text(values, "intent") ?? "queue";
  if (
    (file === undefined) === (inline === undefined) ||
    (intent !== "queue" && intent !== "unblock")
  ) {
    throw new Usage();
  }
  const parsedLinks = links(values);
  const to = required(values, "to");
  let body = inline;
  if (file !== undefined) {
    const bytes = readFileSync(resolve(context.cwd, file));
    if (!isUtf8(bytes)) {
      throw new StoreError("invalid-body-encoding");
    }
    body = bytes.toString("utf8");
  }
  const id = text(values, "id");
  return storeSend(context, callerOf(values), {
    body: body!,
    intent,
    links: parsedLinks,
    to,
    ...(id === undefined ? {} : { id }),
  });
});

export const msgDone: Handler = storeVerb(
  "msg done",
  MSG_DONE_OPTIONS,
  (context, values, [id]) => {
    const work = text(values, "work");
    const supersededBy = text(values, "superseded-by");
    return storeDone(context, callerOf(values), id!, {
      evidence: (values.evidence as string[] | undefined) ?? [],
      ...(supersededBy === undefined ? {} : { supersededBy }),
      ...(work === undefined ? {} : { work }),
    });
  },
  1,
);

export const msgDecide: Handler = storeVerb(
  "msg decide",
  MSG_DECIDE_OPTIONS,
  (context, values, [id]) => {
    const bodySha256 = required(values, "body-sha256");
    const promptRef = text(values, "prompt");
    const scope = text(values, "scope");
    const userReply = text(values, "user-reply");
    const approve = values.approve === true;
    const decline = values.decline === true;
    if (!/^[0-9a-f]{64}$/.test(bodySha256) || values.worker !== undefined) {
      throw new Usage();
    }
    const caller = callerOf(values);
    if (
      promptRef !== undefined &&
      !approve &&
      !decline &&
      scope === undefined &&
      userReply === undefined
    ) {
      return storeMessageDecide(context, caller, id!, { bodySha256, promptRef, status: "pending" });
    }
    if (
      promptRef === undefined &&
      approve &&
      !decline &&
      scope !== undefined &&
      userReply !== undefined
    ) {
      return storeMessageDecide(context, caller, id!, {
        bodySha256,
        scope,
        status: "approved",
        userReply,
      });
    }
    if (
      promptRef === undefined &&
      decline &&
      !approve &&
      scope === undefined &&
      userReply !== undefined
    ) {
      return storeMessageDecide(context, caller, id!, {
        bodySha256,
        status: "declined",
        userReply,
      });
    }
    throw new Usage();
  },
  1,
);

export const msgRetain: Handler = storeVerb(
  "msg retain",
  MSG_RETAIN_OPTIONS,
  (context, values, [id]) => {
    const evidence = values.evidence as string[] | undefined;
    const owner = text(values, "owner");
    const boundary = text(values, "next-boundary");
    const until = text(values, "until");
    const nextReview = values["next-review"] === true;
    const boundaries = [boundary !== undefined, until !== undefined, nextReview].filter(
      Boolean,
    ).length;
    if (boundaries > 1) {
      throw new Usage();
    }
    if (boundaries === 0 && context.layout.config.wakeMinutes.length === 0) {
      throw new Usage(undefined, { kind: "missing", name: "next-boundary" });
    }
    const deadline = until === undefined ? null : retentionInstant(until);
    if (until !== undefined && deadline === null) {
      throw new Usage();
    }
    return storeRetain(context, callerOf(values), id!, {
      ...(evidence === undefined ? {} : { evidence }),
      nextBoundary:
        boundary ?? (deadline === null ? NEXT_REVIEW_BOUNDARY : new Date(deadline).toISOString()),
      reason: required(values, "reason"),
      ...(owner === undefined ? {} : { owner }),
    });
  },
  1,
);

export const msgStatus: Handler = storeVerb(
  "msg status",
  MSG_STATUS_OPTIONS,
  (context, values, [id]) => {
    const includeBody = values["include-body"] === true;
    if (!includeBody && (values["native-id"] !== undefined || values.worker !== undefined)) {
      throw new Usage();
    }
    return storeStatus(context, id!, includeBody ? callerOf(values) : undefined);
  },
  1,
);

export const msgHistory: Handler = storeVerb(
  "msg history",
  MSG_HISTORY_OPTIONS,
  (context, values) => {
    const role = text(values, "role");
    const since = text(values, "since");
    const limit = text(values, "limit");
    if (limit !== undefined && !/^[1-9][0-9]{0,5}$/.test(limit)) {
      throw new Usage();
    }
    const includeBody = values["include-body"] === true;
    if (!includeBody && (values["native-id"] !== undefined || values.worker !== undefined)) {
      throw new Usage();
    }
    return storeHistory(context, {
      ...(includeBody ? { caller: callerOf(values), includeBody } : {}),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
      ...(role === undefined ? {} : { role }),
      ...(since === undefined ? {} : { since: isoInstant(since) }),
    });
  },
);

export const inbox: Handler = storeVerb("inbox", INBOX_OPTIONS, (context, values) => {
  if (values.peek === true) {
    if (values.all === true || values["include-body"] === true) {
      throw new Usage();
    }
    return storeInboxPeek(context, callerOf(values));
  }
  return storeInbox(context, callerOf(values), {
    all: values.all === true,
    includeBody: values["include-body"] === true,
  });
});
