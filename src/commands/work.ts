// `coordination-kit work check` and `work report` over one repository, which --root names (default:
// the working directory). The coordinator root for live state comes only from the environment.
import { parseArgs } from "node:util";

import { coordinatorRoot, EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler } from "../io.ts";
import { checkWork } from "../work/check.ts";
import { reportWork } from "../work/report.ts";

export const WORK_OPTIONS = {} as const;

function usage(args: string[]): boolean {
  try {
    parseArgs({ args, options: WORK_OPTIONS, strict: true });
    return false;
  } catch {
    return true;
  }
}

export const workCheck: Handler = (io, root, args) => {
  if (usage(args)) {
    io.err("coordination-kit: usage: coordination-kit work check [--root DIR]\n");
    return EXIT_USAGE;
  }
  const result = checkWork(root);
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
