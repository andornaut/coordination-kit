import { describe, expect, it } from "vitest";

import { loadLayout } from "../../core/configuration/layout.ts";
import { makeFixture, registryInput, TEST_CLOCK } from "../../core/testFixtures.ts";
import { createRegistry, type Registry } from "../../registry/index.ts";
import { synopsis } from "../spec.ts";
import { harnessDoctor } from "./doctor.ts";

async function run(root: string, ...args: string[]) {
  let out = "";
  let err = "";
  const code = await harnessDoctor(
    {
      cwd: root,
      env: { CODEX_CONTROL_SOCKET: "DO_NOT_PRINT" },
      err: (s) => {
        err += s;
      },
      out: (s) => {
        out += s;
      },
    },
    root,
    args,
  );
  return { code, err, out };
}

describe("harness doctor handler", () => {
  const help = "Run coordination-kit harness doctor --help for accepted syntax.";

  it.each([
    [[], "Choose one selector form above and supply nonblank IDs or roles."],
    [["--role", " "], "Choose one selector form above and supply nonblank IDs or roles."],
    [
      ["--app", "DO_NOT_PRINT", "--game", "DO_NOT_PRINT"],
      `Use only the options listed for this command. ${help}`,
    ],
    [["--DO_NOT_PRINT", "DO_NOT_PRINT"], `Use only the options listed for this command. ${help}`],
    [["--role"], `Check which options take values and supply the required values. ${help}`],
  ] as const)("gives safe scope guidance for %j", async (args, hint) => {
    const forms = synopsis("harness doctor").map((form) => `coordination-kit ${form}`);
    const usage = forms.join("\n");
    expect(await run("/DO_NOT_PRINT", ...args)).toEqual({
      code: 2,
      err: `coordination-kit: invalid_doctor_scope\n${usage}\nHint: ${hint}\n`,
      out: "",
    });
  });

  it("emits one schema 1 JSON line and exits nonzero for an observed failure", async () => {
    const { root } = makeFixture();
    const layout = loadLayout(root);
    const input = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
    createRegistry(TEST_CLOCK, layout, { ...input, harness: "codex" });
    const result = await run(root, "--role", "archies-dog-walks/tech");
    expect(result).toMatchObject({ code: 1, err: "" });
    expect(result.out.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.out)).toMatchObject({
      schema: 1,
      roles: [{ failed_layer: "adapter" }],
    });
    expect(result.out).not.toContain("DO_NOT_PRINT");
    const invalid = await run(root, "--role", "DO_NOT_PRINT");
    expect(invalid).toEqual({
      code: 1,
      out: "",
      err:
        "coordination-kit: doctor_configuration_unavailable\n" +
        "Hint: Check the workspace configuration and registry, then use a configured app or role.\n",
    });
  });
});
