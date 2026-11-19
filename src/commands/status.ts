// `coordination-kit status`: the read-only cross-repository status of every work item, as JSON or
// a Markdown digest. --root names the coordinator, as for every non-work command.
import { parseArgs } from "node:util";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler } from "../io.ts";
import { collectStatus, incomplete, StatusUsageError } from "../status/collect.ts";
import { DERIVED_STATUSES, type DerivedStatus } from "../status/derive.ts";
import { systemGit } from "../status/git.ts";
import { renderMarkdown } from "../status/markdown.ts";
import { sourceCounters } from "../status/sources.ts";

export const STATUS_OPTIONS = {
  audit: { type: "boolean" },
  format: { type: "string" },
  scope: { type: "string" },
  since: { type: "string" },
  state: { multiple: true, type: "string" },
} as const;

const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const USAGE =
  "coordination-kit: usage: coordination-kit status [--scope all|GAME|KIT|ROLE] [--since ISO_TIMESTAMP] " +
  "[--state STATE]... [--audit] [--format json|markdown] [--root DIR]\n";

export const status: Handler = (io, root, args) => {
  let values;
  try {
    ({ values } = parseArgs({ args, options: STATUS_OPTIONS, strict: true }));
  } catch {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const format = values.format ?? "json";
  const states = values.state ?? [];
  const since = values.since ?? null;
  const unknown = states.find((state) => !(DERIVED_STATUSES as readonly string[]).includes(state));
  if (
    !["json", "markdown"].includes(format) ||
    unknown !== undefined ||
    (since !== null && (!ISO.test(since) || Number.isNaN(Date.parse(since))))
  ) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  let report;
  try {
    report = collectStatus({ counters: sourceCounters(), git: systemGit(io.env), io }, root, {
      audit: values.audit === true,
      scope: values.scope ?? "all",
      since,
      states: states as DerivedStatus[],
    });
  } catch (error) {
    if (error instanceof StatusUsageError) {
      io.err(`coordination-kit: ${error.message}\n${USAGE}`);
      return EXIT_USAGE;
    }
    io.err(`coordination-kit: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_INVALID;
  }
  io.out(format === "markdown" ? renderMarkdown(report) : `${JSON.stringify(report)}\n`);
  return incomplete(report) ? EXIT_INVALID : EXIT_OK;
};
