// `coordination-kit status`: the read-only cross-repository status of every work item, as JSON or
// a Markdown digest. --root names the coordinator, as for every non-work command.
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../core/cli/io.ts";
import { type CommandSpec, formSynopsis, usageText } from "../core/cli/usage.ts";
import { localGit } from "../core/git.ts";
import { collectStatus, incomplete, StatusUsageError } from "../status/collect.ts";
import { DEFAULT_VERIFY_SINCE, STATE_FILTERS, type StateFilter } from "../status/derive.ts";
import { renderMarkdown } from "../status/markdown.ts";
import { errorMessage, parseOptions } from "./args.ts";

const STATUS_OPTIONS = {
  audit: { type: "boolean" },
  format: { type: "string" },
  scope: { type: "string" },
  since: { type: "string" },
  state: { multiple: true, type: "string" },
  "verify-since": { type: "string" },
} as const;

export const STATUS_SPEC = {
  forms: [["scope?", "since?", "state?", "audit?", "verify-since?", "format?"]],
  group: "status",
  options: STATUS_OPTIONS,
  summary:
    "read-only status of each registered repository's work items, store records and imported requests",
  values: {
    format: "json|markdown",
    scope: "all|workspace|app:ID|kit:ID|role:KEY|NAME",
    since: "ISO_TIMESTAMP",
    state: "STATE",
    "verify-since": "ISO_TIMESTAMP",
  },
} as const satisfies CommandSpec & { group: "status" };

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const USAGE = usageText("coordination-kit", formSynopsis({}, "status", STATUS_SPEC));

function usage(io: Io, reason?: string): number {
  if (reason !== undefined) {
    io.err(`coordination-kit: ${reason}\n`);
  }
  io.err(`coordination-kit: ${USAGE} [--root DIR]\n`);
  io.err("Scopes are all, workspace, app:ID, kit:ID, role:KEY or an unambiguous bare name.\n");
  return EXIT_USAGE;
}

export const status: Handler = (io, root, args) => {
  let values;
  try {
    ({ values } = parseOptions(STATUS_OPTIONS, args));
  } catch {
    return usage(io);
  }
  const format = values.format ?? "json";
  const states = values.state ?? [];
  const since = values.since ?? null;
  const verifySince = values["verify-since"] ?? DEFAULT_VERIFY_SINCE;
  const unknown = states.some((state) => !(STATE_FILTERS as readonly string[]).includes(state));
  const invalid = (value: string | null) =>
    value !== null && (!ISO.test(value) || Number.isNaN(Date.parse(value)));
  if (!["json", "markdown"].includes(format)) {
    return usage(io, "--format must be json or markdown");
  }
  if (unknown) {
    return usage(io, `--state must be one of ${STATE_FILTERS.join(", ")}`);
  }
  for (const [flag, value] of [
    ["--since", since],
    ["--verify-since", verifySince],
  ] as const) {
    if (invalid(value)) {
      return usage(io, `${flag} needs an ISO date or timestamp with a timezone`);
    }
  }
  let report;
  try {
    report = collectStatus({ git: localGit(io.env), io }, root, {
      audit: values.audit === true,
      scope: values.scope ?? "all",
      since,
      states: states as StateFilter[],
      verifySince,
    });
  } catch (error) {
    if (error instanceof StatusUsageError) {
      return usage(io, error.message);
    }
    io.err(`coordination-kit: ${errorMessage(error)}\n`);
    return EXIT_INVALID;
  }
  io.out(format === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report)}\n`);
  return incomplete(report) ? EXIT_INVALID : EXIT_OK;
};
