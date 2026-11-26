// The store verbs: `msg send|done|retain|status|history`, `inbox` and
// `store import|export|rebuild|retire|compaction-plan`, and `storeVerb`, the wrapper every
// store-backed verb shares. Each prints one JSON object on stdout. A refusal prints
// `coordination-kit: CODE` on stderr and exits 1; a usage error exits 2.
import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { systemGit } from "../core/git.ts";
import type { Handler } from "../core/io.ts";
import { loadLayout } from "../core/layout.ts";
import { Store } from "../store/db.ts";
import { planFileCompaction } from "../store/files/compactionPlan.ts";
import { NEXT_REVIEW_BOUNDARY, retentionInstant } from "../store/retention.ts";
import { storeRetire } from "../store/retire.ts";
import {
  registry,
  storeDone,
  storeExport,
  storeHistory,
  storeInbox,
  storeInboxPeek,
  storeRebuild,
  storeRetain,
  storeSend,
  type StoreServiceContext,
  storeStatus,
} from "../store/service.ts";
import { type MessageLink, StoreError } from "../store/types.ts";
import { importApprovalLedger } from "../work/approvals.ts";
import {
  CALLER,
  callerOf,
  required,
  systemClock,
  text,
  Usage,
  type Values,
  verbFamily,
} from "./args.ts";

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

export const STORE_IMPORT_OPTIONS = {
  ...CALLER,
  "approval-ledger": { type: "string" },
  "dry-run": { type: "boolean" },
} as const;

export const STORE_EXPORT_OPTIONS = { ...CALLER, since: { type: "string" } } as const;

export const STORE_REBUILD_OPTIONS = CALLER;
export const STORE_COMPACTION_PLAN_OPTIONS = {} as const;

export const STORE_RETIRE_OPTIONS = {
  ...CALLER,
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
} as const;

/** An ISO 8601 instant, normalized to the store's `toISOString` form for ordered comparison. */
function instant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Usage();
  }
  return new Date(value).toISOString();
}

/** What a store verb runs against: the service context and the caller's working directory. */
interface StoreCommandContext extends StoreServiceContext {
  readonly cwd: string;
}

/** The store verbs' wrapper: the coordinator layout from `root`, the real clock and environment. */
export const storeVerb = verbFamily("store", (io, root): StoreCommandContext => ({
  clock: systemClock,
  cwd: io.cwd,
  env: io.env,
  layout: loadLayout(root),
}));

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

export const msgRetain: Handler = storeVerb(
  "msg retain",
  MSG_RETAIN_OPTIONS,
  (context, values, [id]) => {
    const evidence = values.evidence as string[] | undefined;
    const owner = text(values, "owner");
    const boundary = text(values, "next-boundary");
    const until = text(values, "until");
    const nextReview = values["next-review"] === true;
    if ([boundary !== undefined, until !== undefined, nextReview].filter(Boolean).length !== 1) {
      throw new Usage();
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
      ...(since === undefined ? {} : { since: instant(since) }),
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

export const storeImportCommand: Handler = storeVerb(
  "store import",
  STORE_IMPORT_OPTIONS,
  (context, values) => {
    const ledger = required(values, "approval-ledger");
    return importApprovalLedger(
      {
        clock: context.clock,
        coordinatorRoot: context.layout.root,
        env: context.env,
        git: systemGit(context.env),
      },
      callerOf(values),
      { dryRun: values["dry-run"] === true, file: resolve(context.cwd, ledger) },
    );
  },
);

export const storeExportCommand: Handler = storeVerb(
  "store export",
  STORE_EXPORT_OPTIONS,
  (context, values) => storeExport(context, instant(required(values, "since")), callerOf(values)),
);

export const storeRebuildCommand: Handler = storeVerb(
  "store rebuild",
  STORE_REBUILD_OPTIONS,
  (context, values) => storeRebuild(context, callerOf(values)),
);

export const storeCompactionPlanCommand: Handler = storeVerb(
  "store compaction-plan",
  STORE_COMPACTION_PLAN_OPTIONS,
  (context) => {
    const { revision, roles } = registry(context);
    const store = Store.readLayout(context, context.layout);
    try {
      if (!store?.fileBacked) {
        throw new StoreError("compaction-file-authority-required");
      }
      const events = store.events();
      if (registry(context).revision !== revision) {
        throw new StoreError("compaction-registry-changed");
      }
      return planFileCompaction(
        events,
        {
          registeredGames: new Set(Object.keys(context.layout.config.games)),
          registeredRoles: new Set(Object.keys(roles)),
          registryRevision: revision,
        },
        store.compactedEventSequences(),
      );
    } finally {
      store?.close();
    }
  },
);

export const storeRetireCommand: Handler = storeVerb(
  "store retire",
  STORE_RETIRE_OPTIONS,
  (context, values) => {
    if ((values.apply === true) === (values["dry-run"] === true)) {
      throw new Usage();
    }
    if (values["dry-run"] === true && (values["native-id"] ?? values.worker) !== undefined) {
      throw new Usage();
    }
    return storeRetire(context, callerOf(values), { apply: values.apply === true });
  },
);
