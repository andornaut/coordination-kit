import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler } from "../core/cli/io.ts";
import type { Options } from "../core/cli/usage.ts";
import { systemGit } from "../core/git.ts";
import { auditDocs } from "../workfiles/docsAudit.ts";
import { planDocsCompaction } from "../workfiles/docsCompact.ts";
import { errorMessage, parseOptions, Usage } from "./args.ts";

export const DOCS_AUDIT_OPTIONS = {
  area: { type: "string" },
  format: { type: "string" },
} as const;

export const DOCS_COMPACT_OPTIONS = {
  ...DOCS_AUDIT_OPTIONS,
  plan: { type: "boolean" },
} as const;

function documentationCommand<T>(
  name: string,
  options: Options,
  read: (git: ReturnType<typeof systemGit>, root: string, area?: string) => T,
  markdown: (result: T) => string,
  success: (result: T) => boolean = () => true,
): Handler {
  return (io, root, args) => {
    let selection: { readonly area?: string; readonly format: "markdown" | "json" };
    try {
      const { values } = parseOptions(options, args);
      const { area, format = "markdown", plan } = values;
      if (Object.hasOwn(options, "plan") && plan !== true) {
        throw new Usage("--plan is required for read-only compaction planning");
      }
      if (format !== "markdown" && format !== "json") {
        throw new Usage("--format must be markdown or json");
      }
      if (area !== undefined && (typeof area !== "string" || area.trim() === "")) {
        throw new Usage("--area must name a documentation topic");
      }
      selection = { ...(area === undefined ? {} : { area }), format };
    } catch (error) {
      io.err(`coordination-kit: ${name}: ${errorMessage(error)}\n`);
      return EXIT_USAGE;
    }
    try {
      const result = read(systemGit(io.env), root, selection.area);
      io.out(selection.format === "json" ? `${JSON.stringify(result)}\n` : markdown(result));
      return success(result) ? EXIT_OK : EXIT_INVALID;
    } catch (error) {
      io.err(`coordination-kit: ${name}: ${errorMessage(error)}\n`);
      return EXIT_INVALID;
    }
  };
}

function auditMarkdown(report: ReturnType<typeof auditDocs>): string {
  return [
    "# Documentation audit",
    "",
    `Revision: \`${report.head}\``,
    ...(report.area === null ? [] : [`Area: \`${report.area}\``]),
    "",
    "## Structural checks",
    "",
    ...(report.findings.length === 0
      ? ["No structural findings."]
      : report.findings.map(
          ({ code, line, message, path }) => `- \`${path}:${line}\` ${code}. ${message}`,
        )),
    "",
    "## Behaviour checklist",
    "",
    ...(report.rules.length === 0
      ? ["No marked rules in scope."]
      : report.rules.flatMap(({ evidence, id, line, path }) => [
          `- [ ] \`${id}\` at \`${path}:${line}\` (unverified)`,
          ...evidence.map(({ target }) => `  - Evidence reference \`${target}\``),
        ])),
    "",
  ].join("\n");
}

export const docsAudit = documentationCommand(
  "docs audit",
  DOCS_AUDIT_OPTIONS,
  auditDocs,
  auditMarkdown,
  (report) => report.ok,
);

function compactionMarkdown(report: ReturnType<typeof planDocsCompaction>): string {
  return [
    "# Documentation compaction plan",
    "",
    `Revision: ${report.head}`,
    ...(report.area === null ? [] : [`Area: ${report.area}`]),
    "",
    "Review the proposals before editing. Confirm live work, acceptance and evidence with the owner.",
    "",
    ...(report.proposals.length === 0
      ? ["No proposals in scope."]
      : report.proposals.flatMap(({ disposition, evidence, kind, path, ...details }) => [
          `- ${path}:${evidence.fromLine}–${evidence.toLine} (${kind}, ${disposition})`,
          `  - Original ${report.head}:${path} at blob ${evidence.blob}`,
          ...("destination" in details ? [`  - Suggested destination ${details.destination}`] : []),
          ...("successor" in details
            ? [`  - Approved replacement ${details.successor.workId}`]
            : []),
          ...("supersededBy" in details
            ? details.supersededBy.map(({ workId }) => `  - Superseded by ${workId}`)
            : []),
          ...("reason" in details ? [`  - Review blocker ${details.reason}`] : []),
          ...evidence.headings.map(({ anchor }) => `  - Preserve heading #${anchor}`),
          ...evidence.decisions.map(({ id }) => `  - Preserve decision ${id}`),
          ...evidence.inboundLinks.map(
            ({ anchor, line, path: source }) =>
              `  - Check reference ${source}:${line}${anchor === null ? "" : ` to #${anchor}`}`,
          ),
        ])),
    "",
  ].join("\n");
}

export const docsCompact = documentationCommand(
  "docs compact",
  DOCS_COMPACT_OPTIONS,
  planDocsCompaction,
  compactionMarkdown,
);
