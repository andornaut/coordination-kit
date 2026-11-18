import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../cli.ts";
import { loadLayout } from "../layout.ts";
import { ProtocolStore } from "../protocol/core.ts";
import { importProtocolMigration, planProtocolMigration } from "../protocol/migration.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, makeFixture, registryInput } from "../testFixtures.ts";

const AT = "2026-11-16T04:00:00.000Z";
const SENTINEL = "SENTINEL-7f3a";
const BINDING = { harness: "claude", nativeId: CLAUDE_COORDINATOR };

async function fixture() {
  const t = makeFixture();
  const layout = loadLayout(t.root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
  const stateRoot = join(t.base, "external-protocol");
  await importProtocolMigration(
    layout,
    planProtocolMigration(layout, { expectedGeneration: 0, stateRoot, workspaceId: "fixture" }),
  );
  let sequence = 0;
  const file = (value: unknown) => {
    const path = join(t.base, `input-${sequence++}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  async function run(...args: string[]) {
    let out = "",
      err = "";
    const code = await main(
      {
        cwd: t.base,
        env: { CODEX_CONTROL_SOCKET: "/never/connect" },
        err: (value) => {
          err += value;
        },
        out: (value) => {
          out += value;
        },
      },
      [...args, "--root", t.root, "--state-root", stateRoot],
    );
    return { code, err, out };
  }
  const claim = await run(
    "protocol",
    "claim",
    "--input-file",
    file({
      at: AT,
      binding: BINDING,
      evidence: "fixture:owner",
      expectedEpoch: 0,
      role: "coordinator",
    }),
  );
  expect(claim, claim.err).toMatchObject({ code: 0 });
  const plan = await new ProtocolStore({ directory: stateRoot }).putArtifact(Buffer.from("plan\n"));
  const context = (id: string) => ({
    at: AT,
    binding: BINDING,
    epoch: 1,
    expectedRevision: new ProtocolStore({ directory: stateRoot }).read("coordinator").revision,
    id,
    role: "coordinator",
  });
  const definition = (overrides: Record<string, unknown> = {}) => ({
    artifacts: [],
    clauseIds: [],
    criteria: [{ consumers: [], id: "check", phases: ["check"], targetId: "target" }],
    id: "work-one",
    messageIds: [],
    plan,
    requestIds: ["request-one"],
    retention: null,
    source: null,
    ...overrides,
  });
  const publish = (value: unknown) => run("protocol", "work-publish", "--input-file", file(value));
  const error = (result: { err: string }) => {
    const value = JSON.parse(result.err) as { error: Record<string, unknown>; ok: boolean };
    expect(value.ok).toBe(false);
    return value.error;
  };
  return { context, definition, error, file, publish, run };
}

describe("protocol command failures", () => {
  it("reports writer in place of context as a missing context field", async () => {
    const t = await fixture();
    const result = await t.publish({
      input: { definition: t.definition(), expectedWorkRevision: 0, ready: false, replaces: null },
      writer: t.context("wrong-key"),
    });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      '{"error":{"code":"invalid-input","path":"/context","rule":"required"},"ok":false}\n',
    );
  });

  it("keeps the replacement code and points at an empty replaces", async () => {
    const t = await fixture();
    const first = await t.publish({
      context: t.context("first"),
      input: { definition: t.definition(), expectedWorkRevision: 0, ready: false, replaces: "" },
    });
    expect(first, first.err).toMatchObject({ code: 0 });
    const changed = t.definition({
      criteria: [{ consumers: [], id: "check", phases: ["check", "acceptance"], targetId: "t" }],
    });
    const result = await t.publish({
      context: t.context("second"),
      input: { definition: changed, expectedWorkRevision: 1, ready: false, replaces: "" },
    });
    expect(result.code).toBe(1);
    expect(t.error(result)).toEqual({
      code: "explicit-replacement-required",
      path: "/input/replaces",
      rule: "empty",
    });
  });

  it("locates an invalid criterion phase, an unknown key and a wrong type with the store code", async () => {
    const t = await fixture();
    const base = { expectedWorkRevision: 0, ready: false, replaces: null };
    const phase = await t.publish({
      context: t.context("phase"),
      input: {
        ...base,
        definition: t.definition({
          criteria: [{ consumers: [], id: "check", phases: ["review"], targetId: "target" }],
        }),
      },
    });
    expect(t.error(phase)).toEqual({
      code: "invalid-work",
      path: "/input/definition/criteria/0/phases/0",
      rule: "enum",
    });
    const unknown = await t.publish({
      context: t.context("unknown"),
      input: { ...base, definition: { ...t.definition(), notes: "extra" } },
    });
    expect(t.error(unknown)).toEqual({
      code: "invalid-work",
      path: "/input/definition/notes",
      rule: "unexpected-key",
    });
    const type = await t.publish({
      context: t.context("type"),
      input: { ...base, definition: t.definition(), ready: "yes" },
    });
    expect(type.code).toBe(1);
    expect(t.error(type)).toEqual({ code: "invalid-work", path: "/input/ready", rule: "type" });
  });

  it("reports invalid-input where the store would fail without a code", async () => {
    const t = await fixture();
    const result = await t.publish({
      context: t.context("null-criterion"),
      input: {
        definition: t.definition({ criteria: [null] }),
        expectedWorkRevision: 0,
        ready: false,
        replaces: null,
      },
    });
    expect(t.error(result)).toEqual({
      code: "invalid-input",
      path: "/input/definition/criteria/0",
      rule: "type",
    });
    const role = await t.publish({
      context: { ...t.context("unregistered"), role: "kits/fixture-unregistered" },
      input: { definition: t.definition(), expectedWorkRevision: 0, ready: false, replaces: null },
    });
    expect(t.error(role)).toEqual({
      code: "invalid-input",
      path: "/context/role",
      rule: "unknown",
    });
  });

  it("surfaces message envelope codes and keeps the options exit code for a bad timestamp", async () => {
    const t = await fixture();
    const envelope = {
      body: "body",
      created: "2026-11-16",
      fromRole: "game-coordinator",
      id: "message-one",
      intent: "queue",
      schema: 1,
      toRole: "archies-dog-walks/tech",
    };
    const input = {
      envelope,
      guards: { artifacts: [], hold: "unknown", question: "unknown", references: [] },
      links: { clauseIds: [], messageIds: [], requestIds: [], workIds: [] },
    };
    const result = await t.run(
      "protocol",
      "message-publish",
      "--input-file",
      t.file({ input, writer: t.context("message") }),
    );
    expect(result.code).toBe(1);
    expect(t.error(result)).toEqual({
      code: "invalid-envelope",
      path: "/input/envelope/created",
      rule: "format",
    });
    const untimed: Record<string, unknown> = t.context("untimed");
    delete untimed.at;
    const usage = await t.run(
      "protocol",
      "message-publish",
      "--input-file",
      t.file({ input: { ...input, envelope: { ...envelope, created: AT } }, writer: untimed }),
    );
    expect(usage.code).toBe(2);
    expect(t.error(usage)).toEqual({
      code: "invalid-protocol-options",
      path: "/writer/at",
      rule: "required",
    });
  });

  it("keeps an existing claim code and adds its field", async () => {
    const t = await fixture();
    const result = await t.run(
      "protocol",
      "claim",
      "--input-file",
      t.file({
        at: AT,
        binding: BINDING,
        evidence: "x",
        expectedEpoch: 0,
        role: "coordinator",
        x: 1,
      }),
    );
    expect(result.code).toBe(1);
    expect(t.error(result)).toEqual({ code: "invalid-claim", path: "/x", rule: "unexpected-key" });
  });

  it("names the stage of an unexpected failure", async () => {
    const t = await fixture();
    const result = await t.run(
      "protocol",
      "boundary",
      "--role",
      "fixture-unregistered",
      "--phase",
      "review",
      "--at",
      AT,
    );
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      '{"error":{"code":"protocol-operation-failed","stage":"boundary"},"ok":false}\n',
    );
  });

  it("never prints input values, keys that are not field names or bodies", async () => {
    const t = await fixture();
    const results = [
      await t.publish({
        context: t.context("sentinel-id"),
        input: {
          definition: t.definition({ id: `${SENTINEL} value` }),
          expectedWorkRevision: 0,
          ready: false,
          replaces: null,
        },
      }),
      await t.publish({
        context: t.context("sentinel-key"),
        input: {
          definition: { ...t.definition(), [`${SENTINEL} key`]: SENTINEL },
          expectedWorkRevision: 0,
          ready: false,
          replaces: null,
        },
      }),
      await t.publish({
        context: { ...t.context("sentinel-role"), role: `${SENTINEL}/role` },
        input: SENTINEL,
      }),
      await t.run(
        "protocol",
        "message-publish",
        "--input-file",
        t.file({
          input: {
            envelope: { body: SENTINEL, fromRole: SENTINEL, id: SENTINEL, schema: 1 },
            guards: {},
            links: {},
          },
          writer: t.context("sentinel-body"),
        }),
      ),
    ];
    for (const result of results) {
      expect(result.code).toBe(1);
      expect(result.err).not.toContain(SENTINEL);
      for (const key of Object.keys(t.error(result))) {
        expect(["code", "path", "rule", "stage"]).toContain(key);
      }
    }
    expect(t.error(results[1]!)).toEqual({
      code: "invalid-work",
      path: "/input/definition",
      rule: "unexpected-key",
    });
  });
});
