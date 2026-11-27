import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../core/cli/io.ts";
import type { Options } from "../core/cli/usage.ts";
import { makeFixture } from "../core/testFixtures.ts";
import { StoreError } from "../store/types.ts";
import { parseOptions, Usage, verbFamily } from "./args.ts";
import { type Command, SPECS } from "./spec.ts";

const COMMANDS = Object.keys(SPECS) as Command[];

/** One positional per upper-case form token, such as `ID`. */
function positionalsOf(command: Command): string[] {
  const forms = SPECS[command].forms as readonly (readonly string[])[];
  const count = Math.max(0, ...forms.map((form) => form.filter((t) => /^[A-Z_]+$/.test(t)).length));
  return Array.from({ length: count }, (_, n) => `item-${n + 1}`);
}

function occurrence(options: Options, name: string): string[] {
  return options[name]?.type === "string" ? [`--${name}`, "value"] : [`--${name}`];
}

function single(options: Options): string[] {
  return Object.keys(options).filter((name) => options[name]?.multiple !== true);
}

function multiple(options: Options): string[] {
  return Object.keys(options).filter((name) => options[name]?.multiple === true);
}

async function run(env: NodeJS.ProcessEnv, root: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(
    { cwd: "/nonexistent", env, err: (text) => (err += text), out: (text) => (out += text) },
    ["--root", root, ...argv],
  );
  return { code, err, out };
}

describe("parseOptions", () => {
  const cases = COMMANDS.flatMap((command) =>
    single(SPECS[command].options).map((name) => [command, name] as const),
  );

  it.each(cases)("%s refuses a repeated --%s and accepts it once", (command, name) => {
    const { options } = SPECS[command];
    const positionals = positionalsOf(command);
    const once = occurrence(options, name);
    expect(() =>
      parseOptions(options, [...positionals, ...once], positionals.length),
    ).not.toThrow();
    expect(() =>
      parseOptions(options, [...positionals, ...once, ...once], positionals.length),
    ).toThrow(new Usage(`--${name} must be given once`, { kind: "repeated", name }));
  });

  const lists = COMMANDS.flatMap((command) =>
    multiple(SPECS[command].options).map((name) => [command, name] as const),
  );

  it.each(lists)("%s repeats the list option --%s", (command, name) => {
    const { options } = SPECS[command];
    const positionals = positionalsOf(command);
    const { values } = parseOptions(
      options as Options,
      [...positionals, `--${name}`, "a", `--${name}`, "b"],
      positionals.length,
    );
    expect((values as Record<string, unknown>)[name]).toEqual(["a", "b"]);
  });

  it.each([
    ["an unknown option", ["--unknown"], 0],
    ["a missing value", ["--to"], 0],
    ["a positional the verb does not take", ["extra"], 0],
    ["a missing positional", [], 1],
    ["a second positional", ["one", "two"], 1],
  ] as const)("refuses %s", (_name, args, positionals) => {
    expect(() => parseOptions(SPECS["msg send"].options, args, positionals)).toThrow(Usage);
  });
});

describe("the verb wrapper", () => {
  it("covers every command: a repeated single-value option is a usage error with no output", async () => {
    const { root } = makeFixture();
    const checked: string[] = [];
    for (const command of COMMANDS) {
      const { options } = SPECS[command];
      const [name] = single(options);
      if (name === undefined) {
        continue;
      }
      const once = occurrence(options, name);
      // eslint-disable-next-line no-await-in-loop
      const result = await run(
        {},
        root,
        ...command.split(" "),
        ...positionalsOf(command),
        ...once,
        ...once,
      );
      expect(result, command).toMatchObject({ code: EXIT_USAGE, out: "" });
      checked.push(command);
    }
    // Every command but those that take no option or only list options.
    expect(COMMANDS.filter((command) => !checked.includes(command)).sort()).toEqual([
      "claude ready",
      "codex ready",
      "harness doctor",
      "harness ready",
      "store compaction-plan",
      "store migration-status",
      "task list",
      "task show",
      "task work-file",
      "work history",
      "work report",
      "work show",
    ]);
  });

  it.each([
    // A repeated single-value option is refused before the verb runs; once, the verb runs.
    ["store", ["hold", "list", "--state", "active"], EXIT_OK, "hold list"],
    ["work", ["work", "start", "ck-0001", "--parent", "a"], EXIT_INVALID, "work start"],
    ["graph", ["graph", "--depth", "1"], EXIT_INVALID, "graph"],
  ] as const)(
    "refuses a repeated option for the %s family",
    async (family, argv, once, command) => {
      const { root } = makeFixture();
      const [option, value] = argv.slice(-2) as [string, string];
      expect((await run({}, root, ...argv)).code).toBe(once);
      expect(await run({}, root, ...argv, option, value)).toEqual({
        code: EXIT_USAGE,
        err:
          `coordination-kit: invalid_${family}_options (${command})\n` +
          `Hint: Give ${option} only once. Run coordination-kit ${command} --help for accepted syntax.\n`,
        out: "",
      });
    },
  );

  it.each([
    ["store", ["msg", "done", " "], "msg done", "Supply a nonblank positional argument."],
    ["store", ["hold", "list", "--role", ""], "hold list", "Give --role a nonblank value."],
    ["work", ["work", "show", " "], "work show", "Supply a nonblank positional argument."],
    ["graph", ["graph", "--work", " "], "graph", "Give --work a nonblank value."],
  ] as const)(
    "refuses a blank value or positional for the %s family",
    async (family, argv, command, hint) => {
      const { root } = makeFixture();
      expect(await run({}, root, ...argv)).toEqual({
        code: EXIT_USAGE,
        err:
          `coordination-kit: invalid_${family}_options (${command})\n` +
          `Hint: ${hint} Run coordination-kit ${command} --help for accepted syntax.\n`,
        out: "",
      });
    },
  );

  it.each([
    [["--DO_NOT_PRINT"], "Use only the options listed for this command."],
    [["/DO_NOT_PRINT"], "Remove extra positional arguments."],
    [["--state"], "Check which options take values and supply the required values."],
  ] as const)("guides recovery from malformed arguments %j", async (args, hint) => {
    const { root } = makeFixture();
    expect(await run({}, root, "hold", "list", ...args)).toEqual({
      code: EXIT_USAGE,
      err:
        "coordination-kit: invalid_store_options (hold list)\n" +
        `Hint: ${hint} Run coordination-kit hold list --help for accepted syntax.\n`,
      out: "",
    });
  });

  it("names a required registered option without rendering supplied values", async () => {
    const { root } = makeFixture();
    expect(await run({}, root, "msg", "send", "--body", "DO_NOT_PRINT")).toEqual({
      code: EXIT_USAGE,
      err:
        "coordination-kit: invalid_store_options (msg send)\n" +
        "Hint: Supply --to. Run coordination-kit msg send --help for accepted syntax.\n",
      out: "",
    });
  });

  it.each(["store", "work", "graph"] as const)(
    "prints the %s family's codes: its fallback, a store refusal and a refusal's reason",
    async (family) => {
      const failing = (error: Error) =>
        verbFamily(family, () => ({}))("x run", {}, () => {
          throw error;
        });
      const reasoned = Object.assign(new StoreError("session-held", "phase held"), {
        reason: "phase held",
      });
      const cases = [
        [new Error("not a store refusal"), `${family}_operation_failed`],
        [new StoreError("not-owner"), "not-owner"],
        [reasoned, "session-held: phase held"],
        [
          new Usage("DO_NOT_PRINT", { kind: "missing", name: "DO_NOT_PRINT" }),
          `invalid_${family}_options (x run)\nHint: Run coordination-kit x run --help for accepted syntax.`,
        ],
      ] as const;
      for (const [error, printed] of cases) {
        const output = { err: "", out: "" };
        const io = {
          cwd: "/",
          env: {},
          err: (text: string) => (output.err += text),
          out: (text: string) => (output.out += text),
        };
        // eslint-disable-next-line no-await-in-loop
        const code = await failing(error)(io, "/", []);
        expect({ code, ...output }).toEqual({
          code: error instanceof Usage ? EXIT_USAGE : EXIT_INVALID,
          err: `coordination-kit: ${printed}\n`,
          out: "",
        });
      }
    },
  );

  it("prints the store fallback code when the coordinator layout cannot load", async () => {
    // The root holds no config.json, so loading its layout fails outside the store.
    const missing = join(makeFixture().base, "missing");
    expect(await run({}, missing, "hold", "list")).toEqual({
      code: EXIT_INVALID,
      err: "coordination-kit: store_operation_failed\n",
      out: "",
    });
  });

  it("lets a list option repeat through the CLI", async () => {
    const { root } = makeFixture();
    const result = await run({}, root, "harness", "doctor", "--role", "a", "--role", "b");
    expect(result.code).not.toBe(EXIT_USAGE);
  });
});
