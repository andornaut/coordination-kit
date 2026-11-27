// Doctor reports capabilities without sending, activating or changing registry state.
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../../core/cli/io.ts";
import { loadLayout } from "../../core/configuration/layout.ts";
import { readRegistry } from "../../registry/store.ts";
import { diagnoseHarness } from "../../review/diagnostics.ts";
import { parseOptions, usageHint } from "../args.ts";

export const DOCTOR_OPTIONS = {
  app: { multiple: true, type: "string" },
  role: { multiple: true, type: "string" },
} as const;

const USAGE =
  "coordination-kit harness doctor --app ID ... [--role ROLE ...]\n" +
  "coordination-kit harness doctor --role ROLE ...";

function invalidScope(io: Io, hint: string): number {
  io.err(`coordination-kit: invalid_doctor_scope\n${USAGE}\n${hint}`);
  return EXIT_USAGE;
}

export const harnessDoctor: Handler = async (io, root, args) => {
  let values;
  try {
    ({ values } = parseOptions(DOCTOR_OPTIONS, args));
  } catch (error) {
    return invalidScope(io, usageHint("harness doctor", DOCTOR_OPTIONS, error));
  }
  if (
    (values.app === undefined && values.role === undefined) ||
    [...(values.app ?? []), ...(values.role ?? [])].some((value) => value.trim() === "")
  ) {
    return invalidScope(
      io,
      "Hint: Choose one selector form above and supply nonblank IDs or roles.\n",
    );
  }
  try {
    const layout = loadLayout(root);
    const report = await diagnoseHarness(io.env, layout, readRegistry(layout), {
      ...(values.app === undefined ? {} : { apps: values.app }),
      ...(values.role === undefined ? {} : { roles: values.role }),
    });
    io.out(`${JSON.stringify(report)}\n`);
    return report.roles.some((row) => row.failed_layer !== null) ? EXIT_INVALID : EXIT_OK;
  } catch {
    io.err(
      "coordination-kit: doctor_configuration_unavailable\n" +
        "Hint: Check the workspace configuration and registry, then use a configured app or role.\n",
    );
    return EXIT_INVALID;
  }
};
