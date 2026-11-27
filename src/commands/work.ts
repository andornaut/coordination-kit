// The work group over one repository, which --root names (default: the working directory): `work
// check` and `work report`, and the store work verbs `work start|evidence|block|unblock|ready|
// finish|show|history`. The coordinator root for live state comes only from the environment.
import {
  coordinatorRoot,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  type Handler,
  type Io,
} from "../core/cli/io.ts";
import type { Options } from "../core/cli/usage.ts";
import { localGit } from "../core/git.ts";
import { WORK_STAGES, type WorkStage } from "../store/work-records/work.ts";
import {
  type LiveContext,
  unrecordedDecisions,
  workBlock as blockService,
  workEvidence as evidenceService,
  workFinish as finishService,
  workHistoryOf,
  workReady as readyService,
  workShow as showService,
  workStart as startService,
  workUnblock as unblockService,
} from "../work/live.ts";
import { checkWork, type Finding, type FindingCode } from "../workfiles/check.ts";
import { reportWork } from "../workfiles/report.ts";
import {
  CALLER,
  callerOf,
  parseOptions,
  refusalCode,
  required,
  systemClock,
  text,
  Usage,
  type Values,
  verbFamily,
} from "./args.ts";

export const WORK_OPTIONS = {} as const;
export const WORK_CHECK_OPTIONS = { decisions: { type: "boolean" } } as const;

export const WORK_START_OPTIONS = { ...CALLER, parent: { type: "string" } } as const;
export const WORK_EVIDENCE_OPTIONS = {
  ...CALLER,
  ref: { type: "string" },
  sha: { type: "string" },
  stage: { type: "string" },
} as const;
export const WORK_BLOCK_OPTIONS = {
  ...CALLER,
  owner: { type: "string" },
  reason: { type: "string" },
} as const;
export const WORK_WRITE_OPTIONS = CALLER;
export const WORK_READ_OPTIONS = {} as const;

export const workCheck: Handler = (io, root, args) => {
  let decisions: boolean;
  try {
    decisions = parseOptions(WORK_CHECK_OPTIONS, args).values.decisions === true;
  } catch {
    io.err("coordination-kit: usage: coordination-kit work check [--decisions] [--root DIR]\n");
    return EXIT_USAGE;
  }
  const checked = checkWork(root);
  let findings: readonly Finding[] = checked.findings;
  if (decisions) {
    const extra: Finding[] = [];
    try {
      for (const missing of unrecordedDecisions(liveContext(io), root)) {
        extra.push({
          code: "decision-unrecorded" satisfies FindingCode,
          message: `store decision ${missing.decision} is not in the work file`,
          path: missing.path,
        });
      }
    } catch (error) {
      extra.push({
        code: "decisions-unavailable",
        message: `store decisions could not be read: ${refusalCode(error, "store_operation_failed")}`,
        path: "docs/work",
      });
    }
    findings = [...findings, ...extra];
  }
  const result = { ...checked, findings, ok: findings.length === 0 };
  io.out(`${JSON.stringify(result)}\n`);
  for (const finding of result.findings) {
    const at = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
    io.err(`coordination-kit: ${at}: ${finding.code}: ${finding.message}\n`);
  }
  return result.ok ? EXIT_OK : EXIT_INVALID;
};

export const workReport: Handler = (io, root, args) => {
  try {
    parseOptions(WORK_OPTIONS, args);
  } catch {
    io.err("coordination-kit: usage: coordination-kit work report [--root DIR]\n");
    return EXIT_USAGE;
  }
  const report = reportWork(coordinatorRoot(io.env), root);
  io.out(`${JSON.stringify(report)}\n`);
  return report.coordinator.status === "unavailable" ? EXIT_INVALID : EXIT_OK;
};

function liveContext(io: Io): LiveContext {
  return {
    clock: systemClock,
    coordinatorRoot: coordinatorRoot(io.env),
    env: io.env,
    git: localGit(io.env),
  };
}

/** What a `work` store verb runs against: the live context and the repository `--root` names. */
interface WorkCommandContext extends LiveContext {
  readonly worktree: string;
}

/** The `work` store verbs' wrapper: each takes exactly one positional, the work item `ID`. */
const workFamily = verbFamily("work", (io, root): WorkCommandContext => ({
  ...liveContext(io),
  worktree: root,
}));

function verb(
  command: string,
  options: Options,
  action: (context: WorkCommandContext, values: Values, id: string) => unknown,
): Handler {
  return workFamily(command, options, (context, values, [id]) => action(context, values, id!), 1);
}

export const workStart = verb("work start", WORK_START_OPTIONS, (context, values, id) => {
  const parent = text(values, "parent");
  return startService(context, callerOf(values), {
    id,
    worktree: context.worktree,
    ...(parent === undefined ? {} : { parent }),
  });
});

export const workEvidence = verb("work evidence", WORK_EVIDENCE_OPTIONS, (context, values, id) => {
  const stage = required(values, "stage");
  if (!(WORK_STAGES as readonly string[]).includes(stage)) {
    throw new Usage();
  }
  const ref = text(values, "ref");
  return evidenceService(context, callerOf(values), {
    id,
    sha: required(values, "sha"),
    stage: stage as WorkStage,
    worktree: context.worktree,
    ...(ref === undefined ? {} : { ref }),
  });
});

export const workBlock = verb("work block", WORK_BLOCK_OPTIONS, (context, values, id) => {
  const owner = text(values, "owner");
  return blockService(context, callerOf(values), {
    id,
    reason: required(values, "reason"),
    worktree: context.worktree,
    ...(owner === undefined ? {} : { owner }),
  });
});

export const workUnblock = verb("work unblock", WORK_WRITE_OPTIONS, (context, values, id) =>
  unblockService(context, callerOf(values), { id, worktree: context.worktree }),
);

export const workReady = verb("work ready", WORK_WRITE_OPTIONS, (context, values, id) =>
  readyService(context, callerOf(values), { id, worktree: context.worktree }),
);

export const workFinish = verb("work finish", WORK_WRITE_OPTIONS, (context, values, id) =>
  finishService(context, callerOf(values), { id, worktree: context.worktree }),
);

export const workShow = verb("work show", WORK_READ_OPTIONS, (context, _values, id) =>
  showService(context, { id, worktree: context.worktree }),
);

export const workHistory = verb("work history", WORK_READ_OPTIONS, (context, _values, id) =>
  workHistoryOf(context, { id, worktree: context.worktree }),
);
