// The work group over one repository, which --root names (default: the working directory): `work
// check` and `work report`, and the store work verbs `work start|evidence|block|unblock|ready|
// finish|show|history`. The coordinator root for live state comes only from the environment.
import { parseArgs } from "node:util";

import {
  coordinatorRoot,
  EXIT_INVALID,
  EXIT_OK,
  EXIT_USAGE,
  type Handler,
  type Io,
} from "../io.ts";
import { systemGit } from "../status/git.ts";
import type { CallerOptions } from "../store/identity.ts";
import { StoreError } from "../store/types.ts";
import { WORK_STAGES, type WorkStage } from "../store/work.ts";
import { checkWork, type Finding, type FindingCode } from "../work/check.ts";
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
import { reportWork } from "../work/report.ts";

export const WORK_OPTIONS = {} as const;
export const WORK_CHECK_OPTIONS = { decisions: { type: "boolean" } } as const;

const CALLER = {
  "native-id": { type: "string" },
  worker: { type: "string" },
} as const;

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

function usage(args: string[]): boolean {
  try {
    parseArgs({ args, options: WORK_OPTIONS, strict: true });
    return false;
  } catch {
    return true;
  }
}

export const workCheck: Handler = (io, root, args) => {
  let decisions: boolean;
  try {
    decisions =
      parseArgs({ args, options: WORK_CHECK_OPTIONS, strict: true }).values.decisions === true;
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
        message: `store decisions could not be read: ${errorCode(error)}`,
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
  if (usage(args)) {
    io.err("coordination-kit: usage: coordination-kit work report [--root DIR]\n");
    return EXIT_USAGE;
  }
  const report = reportWork(io, coordinatorRoot(io.env), root);
  io.out(`${JSON.stringify(report)}\n`);
  return report.coordinator.status === "unavailable" ? EXIT_INVALID : EXIT_OK;
};

function liveContext(io: Io): LiveContext {
  return { coordinatorRoot: coordinatorRoot(io.env), env: io.env, git: systemGit(io.env) };
}

function errorCode(error: unknown): string {
  return error instanceof StoreError && /^[a-z][a-z-]{0,63}$/.test(error.code)
    ? error.code
    : "store_operation_failed";
}

type Values = Record<string, string | boolean | undefined>;

class Usage extends Error {}

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

/** Parse `ID` and the options, run one service call and print its JSON; refusals exit 1. */
function verb(
  command: string,
  options: Record<string, { readonly type: "string" | "boolean" }>,
  action: (context: LiveContext, values: Values, id: string, root: string) => unknown,
): Handler {
  return (io, root, args) => {
    let values: Values;
    let id: string;
    try {
      const parsed = parseArgs({ allowPositionals: true, args, options, strict: true });
      values = parsed.values as Values;
      if (
        parsed.positionals.length !== 1 ||
        Object.values(values).some((value) => typeof value === "string" && value.trim() === "")
      ) {
        throw new Usage();
      }
      id = parsed.positionals[0]!;
    } catch {
      io.err(`coordination-kit: invalid_work_options (${command})\n`);
      return EXIT_USAGE;
    }
    try {
      io.out(`${JSON.stringify(action(liveContext(io), values, id, root))}\n`);
      return EXIT_OK;
    } catch (error) {
      if (error instanceof Usage) {
        io.err(`coordination-kit: invalid_work_options (${command})\n`);
        return EXIT_USAGE;
      }
      io.err(`coordination-kit: ${errorCode(error)}\n`);
      return EXIT_INVALID;
    }
  };
}

export const workStart = verb("work start", WORK_START_OPTIONS, (context, values, id, root) => {
  const parent = text(values, "parent");
  return startService(context, callerOf(values), {
    id,
    worktree: root,
    ...(parent === undefined ? {} : { parent }),
  });
});

export const workEvidence = verb(
  "work evidence",
  WORK_EVIDENCE_OPTIONS,
  (context, values, id, root) => {
    const stage = required(values, "stage");
    if (!(WORK_STAGES as readonly string[]).includes(stage)) {
      throw new Usage();
    }
    const ref = text(values, "ref");
    return evidenceService(context, callerOf(values), {
      id,
      sha: required(values, "sha"),
      stage: stage as WorkStage,
      worktree: root,
      ...(ref === undefined ? {} : { ref }),
    });
  },
);

export const workBlock = verb("work block", WORK_BLOCK_OPTIONS, (context, values, id, root) => {
  const owner = text(values, "owner");
  return blockService(context, callerOf(values), {
    id,
    reason: required(values, "reason"),
    worktree: root,
    ...(owner === undefined ? {} : { owner }),
  });
});

export const workUnblock = verb("work unblock", WORK_WRITE_OPTIONS, (context, values, id, root) =>
  unblockService(context, callerOf(values), { id, worktree: root }),
);

export const workReady = verb("work ready", WORK_WRITE_OPTIONS, (context, values, id, root) =>
  readyService(context, callerOf(values), { id, worktree: root }),
);

export const workFinish = verb("work finish", WORK_WRITE_OPTIONS, (context, values, id, root) =>
  finishService(context, callerOf(values), { id, worktree: root }),
);

export const workShow = verb("work show", WORK_READ_OPTIONS, (context, _values, id, root) =>
  showService(context, { id, worktree: root }),
);

export const workHistory = verb("work history", WORK_READ_OPTIONS, (context, _values, id, root) =>
  workHistoryOf(context, { id, worktree: root }),
);
