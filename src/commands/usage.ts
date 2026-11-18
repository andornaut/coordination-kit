// Help synopses generated from parser options, so a flag a command accepts always appears in its
// help. Binary-neutral: each CLI names itself and supplies its own command table.
import type { ParseArgsConfig } from "node:util";

export type Options = NonNullable<ParseArgsConfig["options"]>;

export interface CommandSpec {
  readonly summary: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly options: Options;
  /**
   * The accepted forms. Each lists the options it takes in help order; a trailing `?` marks one
   * as optional. Every option appears in at least one form.
   */
  readonly forms: readonly (readonly string[])[];
}

function flag(placeholders: Readonly<Record<string, string>>, spec: CommandSpec, token: string) {
  const optional = token.endsWith("?");
  const name = optional ? token.slice(0, -1) : token;
  const option = spec.options[name];
  if (option === undefined) {
    throw new Error(`help names an unknown option --${name}`);
  }
  const value =
    option.type === "string" ? ` ${spec.values?.[name] ?? placeholders[name] ?? "VALUE"}` : "";
  const text = `--${name}${value}${option.multiple === true ? " ..." : ""}`;
  return optional ? `[${text}]` : text;
}

/** One `COMMAND ...` line per accepted form; `placeholders` names each string option's value. */
export function formSynopsis(
  placeholders: Readonly<Record<string, string>>,
  command: string,
  spec: CommandSpec,
): string[] {
  return spec.forms.map((form) =>
    [command, ...form.map((token) => flag(placeholders, spec, token))].join(" "),
  );
}

/** The usage text a command prints with a usage error: one `BINARY ...` line per form. */
export function usageText(binary: string, lines: readonly string[]): string {
  return lines
    .map((line, index) => `${index === 0 ? "usage:" : "      "} ${binary} ${line}`)
    .join("\n");
}
