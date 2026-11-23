// The store verbs: `msg send|done|retain|status|history`, `inbox` and
// `store import|export|rebuild|retire|compaction-plan`, and the parsing helpers the question verbs share.
// Each prints one JSON object on stdout. A refusal prints `coordination-kit: CODE` on stderr and
// exits 1; a usage error exits 2.
import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { loadLayout } from "../layout.ts";
import { systemGit } from "../status/git.ts";
import { Store } from "../store/db.ts";
import { planFileCompaction } from "../store/files/compactionPlan.ts";
import type { CallerOptions } from "../store/identity.ts";
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
import type { Options } from "./usage.ts";

const CALLER = {
  "native-id": { type: "string" },
  worker: { type: "string" },
} as const;

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

export const STORE_EXPORT_OPTIONS = { since: { type: "string" } } as const;

export const STORE_REBUILD_OPTIONS = {} as const;
export const STORE_COMPACTION_PLAN_OPTIONS = {} as const;

export const STORE_RETIRE_OPTIONS = {
  ...CALLER,
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
} as const;

export type Values = Record<string, string | boolean | string[] | undefined>;

export class Usage extends Error {}

function parse(
  spec: Options,
  args: string[],
  positionals = 0,
): { values: Values; positionals: string[] } {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: positionals > 0,
      args,
      options: spec,
      strict: true,
      tokens: true,
    });
  } catch {
    throw new Usage();
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind === "option" && spec[token.name]?.multiple !== true) {
      if (seen.has(token.name)) {
        throw new Usage();
      }
      seen.add(token.name);
    }
  }
  const values = parsed.values as Values;
  const strings = Object.values(values).flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  if (
    strings.some((value) => typeof value === "string" && value.trim() === "") ||
    parsed.positionals.length !== positionals
  ) {
    throw new Usage();
  }
  return { positionals: parsed.positionals, values };
}

export function text(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

export function required(values: Values, key: string): string {
  const value = text(values, key);
  if (value === undefined) {
    throw new Usage();
  }
  return value;
}

export function callerOf(values: Values): CallerOptions {
  const nativeId = text(values, "native-id");
  const worker = text(values, "worker");
  return {
    ...(nativeId === undefined ? {} : { nativeId }),
    ...(worker === undefined ? {} : { worker }),
  };
}

/** An ISO 8601 instant, normalized to the store's `toISOString` form for ordered comparison. */
function instant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Usage();
  }
  return new Date(value).toISOString();
}

export async function run(
  io: Io,
  root: string,
  command: string,
  args: string[],
  action: (context: StoreServiceContext, values: Values, positionals: string[]) => unknown,
  spec: Options,
  positionals = 0,
): Promise<number> {
  let parsed;
  try {
    parsed = parse(spec, args, positionals);
  } catch {
    io.err(`coordination-kit: invalid_store_options (${command})\n`);
    return EXIT_USAGE;
  }
  try {
    const result = await action(
      { env: io.env, layout: loadLayout(root) },
      parsed.values,
      parsed.positionals,
    );
    io.out(`${JSON.stringify(result)}\n`);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof Usage) {
      io.err(`coordination-kit: invalid_store_options (${command})\n`);
      return EXIT_USAGE;
    }
    const code =
      error instanceof StoreError && /^[a-z][a-z-]{0,63}$/.test(error.code)
        ? error.code
        : "store_operation_failed";
    // A refusal with a short reason, such as `session-held: phase held`, prints it after the code.
    const reason =
      error instanceof StoreError &&
      "reason" in error &&
      typeof error.reason === "string" &&
      /^[a-z0-9 -]{1,64}$/.test(error.reason)
        ? `: ${error.reason}`
        : "";
    io.err(`coordination-kit: ${code}${reason}\n`);
    return EXIT_INVALID;
  }
}

function links(values: Values): MessageLink[] {
  return ((values.link as string[] | undefined) ?? []).map((value) => {
    const at = value.indexOf("=");
    if (at <= 0 || at === value.length - 1) {
      throw new Usage();
    }
    return { kind: value.slice(0, at), ref: value.slice(at + 1) };
  });
}

export const msgSend: Handler = (io, root, args) =>
  run(
    io,
    root,
    "msg send",
    args,
    (context, values) => {
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
        const bytes = readFileSync(resolve(io.cwd, file));
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
    },
    MSG_SEND_OPTIONS,
  );

export const msgDone: Handler = (io, root, args) =>
  run(
    io,
    root,
    "msg done",
    args,
    (context, values, [id]) => {
      const work = text(values, "work");
      const supersededBy = text(values, "superseded-by");
      return storeDone(context, callerOf(values), id!, {
        evidence: (values.evidence as string[] | undefined) ?? [],
        ...(supersededBy === undefined ? {} : { supersededBy }),
        ...(work === undefined ? {} : { work }),
      });
    },
    MSG_DONE_OPTIONS,
    1,
  );

export const msgRetain: Handler = (io, root, args) =>
  run(
    io,
    root,
    "msg retain",
    args,
    (context, values, [id]) => {
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
        nextBoundary:
          boundary ?? (deadline === null ? NEXT_REVIEW_BOUNDARY : new Date(deadline).toISOString()),
        reason: required(values, "reason"),
        ...(owner === undefined ? {} : { owner }),
      });
    },
    MSG_RETAIN_OPTIONS,
    1,
  );

export const msgStatus: Handler = (io, root, args) =>
  run(
    io,
    root,
    "msg status",
    args,
    (context, values, [id]) => {
      const includeBody = values["include-body"] === true;
      if (!includeBody && (values["native-id"] !== undefined || values.worker !== undefined)) {
        throw new Usage();
      }
      return storeStatus(context, id!, includeBody ? callerOf(values) : undefined);
    },
    MSG_STATUS_OPTIONS,
    1,
  );

export const msgHistory: Handler = (io, root, args) =>
  run(
    io,
    root,
    "msg history",
    args,
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
    MSG_HISTORY_OPTIONS,
  );

export const inbox: Handler = (io, root, args) =>
  run(
    io,
    root,
    "inbox",
    args,
    (context, values) => {
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
    },
    INBOX_OPTIONS,
  );

export const storeImportCommand: Handler = (io, root, args) =>
  run(
    io,
    root,
    "store import",
    args,
    (context, values) => {
      const ledger = required(values, "approval-ledger");
      return importApprovalLedger(
        { coordinatorRoot: context.layout.root, env: context.env, git: systemGit(context.env) },
        callerOf(values),
        { dryRun: values["dry-run"] === true, file: resolve(io.cwd, ledger) },
      );
    },
    STORE_IMPORT_OPTIONS,
  );

export const storeExportCommand: Handler = (io, root, args) =>
  run(
    io,
    root,
    "store export",
    args,
    (context, values) => storeExport(context, instant(required(values, "since"))),
    STORE_EXPORT_OPTIONS,
  );

export const storeRebuildCommand: Handler = (io, root, args) =>
  run(io, root, "store rebuild", args, (context) => storeRebuild(context), STORE_REBUILD_OPTIONS);

export const storeCompactionPlanCommand: Handler = (io, root, args) =>
  run(
    io,
    root,
    "store compaction-plan",
    args,
    (context) => {
      const { revision, roles } = registry(context);
      const store = Store.readLayout(context.layout);
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
    STORE_COMPACTION_PLAN_OPTIONS,
  );

export const storeRetireCommand: Handler = (io, root, args) =>
  run(
    io,
    root,
    "store retire",
    args,
    (context, values) => {
      if ((values.apply === true) === (values["dry-run"] === true)) {
        throw new Usage();
      }
      if (values["dry-run"] === true && (values["native-id"] ?? values.worker) !== undefined) {
        throw new Usage();
      }
      return storeRetire(context, callerOf(values), { apply: values.apply === true });
    },
    STORE_RETIRE_OPTIONS,
  );
