// The store verbs: `msg send|done|retain|status|history`, `inbox` and
// `store import|export|rebuild|cutover`.
// Each prints one JSON object on stdout. A refusal prints `coordination-kit: CODE` on stderr and
// exits 1; a usage error exits 2.
import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../io.ts";
import { loadLayout } from "../layout.ts";
import { systemGit } from "../status/git.ts";
import { storeCutover } from "../store/cutover.ts";
import type { CallerOptions } from "../store/identity.ts";
import {
  storeDone,
  storeExport,
  storeHistory,
  storeImport,
  storeInbox,
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
  owner: { type: "string" },
  reason: { type: "string" },
} as const;

export const MSG_STATUS_OPTIONS = {} as const;

export const MSG_HISTORY_OPTIONS = {
  limit: { type: "string" },
  role: { type: "string" },
  since: { type: "string" },
} as const;

export const INBOX_OPTIONS = {
  ...CALLER,
  all: { type: "boolean" },
  "include-body": { type: "boolean" },
} as const;

export const STORE_IMPORT_OPTIONS = {
  ...CALLER,
  "approval-ledger": { type: "string" },
  "dry-run": { type: "boolean" },
  "from-legacy": { type: "boolean" },
} as const;

export const STORE_EXPORT_OPTIONS = { since: { type: "string" } } as const;

export const STORE_REBUILD_OPTIONS = {} as const;

export const STORE_CUTOVER_OPTIONS = {
  ...CALLER,
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
} as const;

type Values = Record<string, string | boolean | string[] | undefined>;

class Usage extends Error {}

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

function text(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function required(values: Values, key: string): string {
  const value = text(values, key);
  if (value === undefined) {
    throw new Usage();
  }
  return value;
}

function callerOf(values: Values): CallerOptions {
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

async function run(
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
    io.err(`coordination-kit: ${code}\n`);
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
      return storeRetain(context, callerOf(values), id!, {
        nextBoundary: required(values, "next-boundary"),
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
    (context, _values, [id]) => storeStatus(context, id!),
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
      return storeHistory(context, {
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
    (context, values) =>
      storeInbox(context, callerOf(values), {
        all: values.all === true,
        includeBody: values["include-body"] === true,
      }),
    INBOX_OPTIONS,
  );

export const storeImportCommand: Handler = (io, root, args) =>
  run(
    io,
    root,
    "store import",
    args,
    (context, values) => {
      const ledger = text(values, "approval-ledger");
      if ((values["from-legacy"] === true) === (ledger !== undefined)) {
        throw new Usage();
      }
      if (ledger !== undefined) {
        return importApprovalLedger(
          { coordinatorRoot: context.layout.root, env: context.env, git: systemGit(context.env) },
          callerOf(values),
          { dryRun: values["dry-run"] === true, file: resolve(io.cwd, ledger) },
        );
      }
      return storeImport(context, callerOf(values), { dryRun: values["dry-run"] === true });
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

export const storeCutoverCommand: Handler = (io, root, args) =>
  run(
    io,
    root,
    "store cutover",
    args,
    (context, values) => {
      if ((values.apply === true) === (values["dry-run"] === true)) {
        throw new Usage();
      }
      return storeCutover(context, callerOf(values), { apply: values.apply === true });
    },
    STORE_CUTOVER_OPTIONS,
  );
