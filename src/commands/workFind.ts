import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../core/cli/io.ts";
import { findNamedWork } from "../core/discovery.ts";
import { localGit } from "../core/git.ts";
import {
  collectStatus,
  incomplete,
  type StatusReport,
  statusRepositoryPath,
  StatusUsageError,
  statusWorkOwner,
} from "../status/collect.ts";
import { DEFAULT_VERIFY_SINCE } from "../status/derive.ts";
import { ROLE } from "../store/types.ts";
import { parseOptions, Usage, usageHint } from "./args.ts";

export const WORK_FIND_OPTIONS = {
  owner: { type: "string" },
  scope: { type: "string" },
} as const;

function usage(io: Io, problem: unknown): number {
  const reason = problem instanceof StatusUsageError ? `${problem.message}\n` : "";
  const hint = usageHint("work find", WORK_FIND_OPTIONS, problem);
  io.err(`coordination-kit: invalid_work_options (work find)\n${reason}${hint}`);
  return EXIT_USAGE;
}

export const workFind: Handler = (io, root, args) => {
  let description: string;
  let owner: string | null;
  let scope: string;
  try {
    const { positionals, values } = parseOptions(WORK_FIND_OPTIONS, args, 1);
    description = positionals[0]!.trim();
    if (description === "") {
      throw new Usage(undefined, "blank-positional");
    }
    owner = values.owner ?? null;
    if (owner !== null && !ROLE.test(owner)) {
      io.err("coordination-kit: --owner must be an exact role key.\n");
      return usage(io, undefined);
    }
    scope = values.scope ?? "all";
    if (scope.trim() === "") {
      throw new Usage(undefined, { kind: "blank", name: "scope" });
    }
  } catch (error) {
    return usage(io, error);
  }

  let report: StatusReport | undefined;
  try {
    report = collectStatus({ git: localGit(io.env), io }, root, {
      audit: false,
      scope,
      since: null,
      states: [],
      verifySince: DEFAULT_VERIFY_SINCE,
    });
  } catch (error) {
    if (error instanceof StatusUsageError) {
      return usage(io, error);
    }
  }

  const complete = report !== undefined && !incomplete(report);
  const records = (report?.items ?? []).filter(
    (item) => owner === null || item[statusWorkOwner] === owner,
  );
  const result = findNamedWork(description, records, complete);
  io.out(
    `${JSON.stringify({
      ...result,
      activeHolds: report?.activeHolds ?? [],
      availability: {
        complete,
        repositories: report?.repositories ?? [],
        store: report?.coordinator.store ?? { reason: "status-unavailable", status: "unavailable" },
      },
      matches: result.matches.map((item) => ({
        ...item,
        repositoryPath: item[statusRepositoryPath] ?? null,
        workOwner: item[statusWorkOwner] ?? null,
      })),
      owner,
      pendingQuestions: report?.pendingQuestions ?? [],
      schema: 1,
      scope,
    })}\n`,
  );
  return result.status === "unavailable" ? EXIT_INVALID : EXIT_OK;
};
