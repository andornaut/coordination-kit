// What the command handlers share: the caller options, the one option parser, the one verb wrapper
// for the store, `work` and `graph` verbs, reading parsed values, and turning an error into its
// printed message or refusal code. The real clock is read here and in the entry points only.
import { parseArgs } from "node:util";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, type Handler, type Io } from "../core/cli/io.ts";
import type { Options } from "../core/cli/usage.ts";
import type { Clock } from "../core/clock.ts";
import type { CallerOptions } from "../store/sessions/identity.ts";
import { StoreError } from "../store/types.ts";

/** The options every store writer takes to name its caller. */
export const CALLER = {
  "native-id": { type: "string" },
  worker: { type: "string" },
} as const;

export type Values = Record<string, string | boolean | string[] | undefined>;

/** The values `parseArgs` types for `options`. */
type Parsed<O extends Options> = ReturnType<
  typeof parseArgs<{ options: O; strict: true }>
>["values"];

type UsageProblem =
  | "unknown-option"
  | "option-value"
  | "unexpected-positional"
  | "positional-count"
  | "blank-positional"
  | { readonly kind: "repeated" | "missing" | "blank"; readonly name: string };

/** A usage error with an optional cause suitable for public guidance. */
export class Usage extends Error {
  readonly problem: UsageProblem | undefined;

  constructor(message?: string, problem?: UsageProblem) {
    super(message);
    this.problem = problem;
  }
}

function parserProblem(error: unknown): UsageProblem | undefined {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  switch (code) {
    case "ERR_PARSE_ARGS_UNKNOWN_OPTION":
      return "unknown-option";
    case "ERR_PARSE_ARGS_INVALID_OPTION_VALUE":
      return "option-value";
    case "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL":
      return "unexpected-positional";
    default:
      return undefined;
  }
}

function usageAdvice(options: Options, problem: UsageProblem | undefined): string {
  switch (problem) {
    case "unknown-option":
      return "Use only the options listed for this command. ";
    case "option-value":
      return "Check which options take values and supply the required values. ";
    case "unexpected-positional":
      return "Remove extra positional arguments. ";
    case "positional-count":
      return "Use the number of arguments shown in the command syntax. ";
    case "blank-positional":
      return "Supply a nonblank positional argument. ";
    case undefined:
      return "";
  }
  const { kind, name } = problem;
  if (!Object.hasOwn(options, name) || !/^[a-z][a-z0-9-]*$/.test(name)) {
    return "";
  }
  switch (kind) {
    case "repeated":
      return `Give --${name} only once. `;
    case "missing":
      return `Supply --${name}. `;
    case "blank":
      return `Give --${name} a nonblank value. `;
    default:
      return "";
  }
}

/** Use a registered command name and curated guidance, without rendering the error's message. */
export function usageHint(command: string, options: Options, error: unknown): string {
  const advice = usageAdvice(options, error instanceof Usage ? error.problem : undefined);
  return `Hint: ${advice}Run coordination-kit ${command} --help for accepted syntax.\n`;
}

/** The wall clock the command layer passes down to library code. */
export const systemClock: Clock = () => new Date();

/**
 * Parse `args` strictly against `options`: an unknown option, a missing option value, a
 * single-value option given more than once, or a positional count other than `positionals` throws
 * `Usage`. Options declared `multiple` repeat.
 */
export function parseOptions<const O extends Options>(
  options: O,
  args: readonly string[],
  positionals = 0,
): { readonly values: Parsed<O>; readonly positionals: string[] } {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: positionals > 0,
      args: [...args],
      options,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    throw new Usage(errorMessage(error), parserProblem(error));
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind === "option" && options[token.name]?.multiple !== true) {
      if (seen.has(token.name)) {
        throw new Usage(`--${token.name} must be given once`, {
          kind: "repeated",
          name: token.name,
        });
      }
      seen.add(token.name);
    }
  }
  if (parsed.positionals.length !== positionals) {
    throw new Usage(`expected ${positionals} positional argument(s)`, "positional-count");
  }
  return { positionals: parsed.positionals, values: parsed.values as Parsed<O> };
}

/** A verb family: its usage code is `invalid_FAMILY_options`, its fallback `FAMILY_operation_failed`. */
export type Family = "store" | "work" | "graph" | "task";

/** A short reason a refusal prints after its code, such as `session-held: phase held`. */
function reasonOf(error: unknown): string {
  return error instanceof StoreError &&
    "reason" in error &&
    typeof error.reason === "string" &&
    /^[a-z0-9 -]{1,64}$/.test(error.reason)
    ? `: ${error.reason}`
    : "";
}

/**
 * The one wrapper for the store, `work` and `graph` verbs. It parses with `parseOptions`, also
 * refusing a blank option value or positional, builds the family's context and runs `action`. A
 * string result prints as is; any other result prints as one JSON line. The default result exit
 * code is 0. A `Usage` error prints
 * `coordination-kit: invalid_FAMILY_options (COMMAND)` with a hint and exits 2. Any other error prints
 * `coordination-kit: CODE`, the store refusal code or `FAMILY_operation_failed`, with the
 * refusal's short reason after it when it carries one, and exits 1.
 */
export function verbFamily<C>(
  family: Family,
  contextOf: (io: Io, root: string) => C,
): <Result>(
  command: string,
  options: Options,
  action: (context: C, values: Values, positionals: readonly string[]) => Result,
  positionals?: number,
  exitCode?: (result: Awaited<Result>) => number,
) => Handler {
  const usage = (io: Io, command: string, options: Options, error: unknown): number => {
    const hint = usageHint(command, options, error);
    io.err(`coordination-kit: invalid_${family}_options (${command})\n${hint}`);
    return EXIT_USAGE;
  };
  return (command, options, action, positionals = 0, exitCode) =>
    async (io, root, args) => {
      let parsed;
      try {
        parsed = parseOptions(options, args, positionals);
        for (const [name, value] of Object.entries(parsed.values as Values)) {
          const entries = Array.isArray(value) ? value : [value];
          if (entries.some((entry) => typeof entry === "string" && entry.trim() === "")) {
            throw new Usage(undefined, { kind: "blank", name });
          }
        }
        if (parsed.positionals.some((value) => value.trim() === "")) {
          throw new Usage(undefined, "blank-positional");
        }
      } catch (error) {
        return usage(io, command, options, error);
      }
      try {
        const result = await action(
          contextOf(io, root),
          parsed.values as Values,
          parsed.positionals,
        );
        io.out(typeof result === "string" ? result : `${JSON.stringify(result)}\n`);
        return exitCode?.(result) ?? EXIT_OK;
      } catch (error) {
        if (error instanceof Usage) {
          return usage(io, command, options, error);
        }
        io.err(
          `coordination-kit: ${refusalCode(error, `${family}_operation_failed`)}${reasonOf(error)}\n`,
        );
        return EXIT_INVALID;
      }
    };
}

export function text(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

export function required(values: Values, key: string): string {
  const value = text(values, key);
  if (value === undefined) {
    throw new Usage(`--${key} is required`, { kind: "missing", name: key });
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A store refusal's code when it is a plain token, else `fallback`. */
export function refusalCode(error: unknown, fallback: string): string {
  return error instanceof StoreError && /^[a-z][a-z-]{0,63}$/.test(error.code)
    ? error.code
    : fallback;
}

/** An ISO 8601 instant, normalized to the store's `toISOString` form for ordered comparison. */
export function isoInstant(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Usage();
  }
  return new Date(value).toISOString();
}
