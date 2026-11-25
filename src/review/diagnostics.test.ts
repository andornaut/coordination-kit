import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeChannelStatus } from "../adapters/claude/channelStatus.ts";
import { type FakeControl, startFakeControl } from "../adapters/codex/testControlSocket.ts";
import { loadLayout } from "../core/layout.ts";
import { CLAUDE_TECH, CODEX_TECH, makeFixture, registryInput } from "../core/testFixtures.ts";
import { createRegistry, readRegistry, type Registry } from "../registry/index.ts";
import { diagnoseHarness } from "./diagnostics.ts";

const ROLE = "archies-dog-walks/tech";

/** The stable channel launch command: the coordinator's installed bundle. */
function stableChannelCommand(root: string): string[] {
  return [
    "node",
    join(root, "node_modules", "@andornaut", "coordination-kit", "dist", "cli.js"),
    "--root",
    root,
    "claude",
    "channel",
  ];
}
const controls: FakeControl[] = [];
afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
});

function setup(harness: "codex" | "claude" = "codex", ownership = "active", phase = "active") {
  const fixture = makeFixture();
  const layout = loadLayout(fixture.root);
  const input = registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">;
  const registry = createRegistry(layout, {
    ...input,
    harness,
    roles: {
      ...input.roles,
      [ROLE]: { ...input.roles[ROLE]!, ownership, phase },
    },
  });
  return { ...fixture, layout, registry };
}

describe("scoped harness diagnostics", () => {
  it("reads only the selected exact Codex thread and separates service from frontend and bridge", async () => {
    const test = setup("codex", "active", "prototype-approved");
    const before = readFileSync(test.layout.registryFile, "utf8");
    const control = await startFakeControl(test.base, (method, params) => {
      expect(method).toBe("thread/read");
      expect(params).toEqual({ includeTurns: false, threadId: CODEX_TECH });
      return {
        result: {
          thread: { id: CODEX_TECH, status: { type: "idle" }, privateBody: "DO_NOT_PRINT" },
        },
      };
    });
    controls.push(control);
    const report = await diagnoseHarness(
      { CODEX_CONTROL_SOCKET: control.path, CLAUDE_BIN: "/never/run" },
      test.layout,
      test.registry,
      { roles: [ROLE] },
    );
    expect(report).toMatchObject({
      schema: 1,
      roles: [
        {
          role: ROLE,
          effective_harness: "codex",
          native_id: CODEX_TECH,
          endpoint: { path: control.path, source: "environment" },
          activation: "unknown",
          native_hold: "unknown",
          failed_layer: null,
          native_session: { status: "available" },
          layers: {
            service: { status: "available" },
            frontend: { status: "unknown" },
            bridge: { status: "unknown" },
            channel: { status: "unknown" },
          },
        },
      ],
    });
    expect(control.calls.map((call) => call.method)).toEqual([
      "initialize",
      "initialized",
      "thread/read",
    ]);
    expect(JSON.stringify(report)).not.toContain("DO_NOT_PRINT");
    expect(readFileSync(test.layout.registryFile, "utf8")).toBe(before);
    expect(readRegistry(test.layout)).toEqual(test.registry);
  });

  it("does not probe inactive bindings or convert registry holds into native HOLD proof", async () => {
    const test = setup("codex", "held");
    const before = readFileSync(test.layout.registryFile, "utf8");
    const control = await startFakeControl(test.base, () => ({ result: {} }));
    controls.push(control);
    const art = "archies-dog-walks/art";
    const gameplay = "archies-dog-walks/gameplay";
    const registry: Registry = {
      ...test.registry,
      roles: {
        ...test.registry.roles,
        [art]: { ...test.registry.roles[ROLE]!, ownership: "active", phase: "held" },
        [gameplay]: { ...test.registry.roles[ROLE]!, ownership: "active", phase: "source-held" },
      },
    };
    const report = await diagnoseHarness(
      { CODEX_CONTROL_SOCKET: control.path, CLAUDE_BIN: "/never/run" },
      test.layout,
      registry,
      { roles: [ROLE, art, gameplay] },
    );
    expect(report.roles.map((row) => row.role)).toEqual([art, gameplay, ROLE]);
    for (const row of report.roles) {
      expect(row).toMatchObject({
        endpoint: { source: "skipped" },
        native_hold: "unknown",
        activation: "unknown",
        layers: { adapter: { status: "unknown", code: "scope_not_active" } },
      });
    }
    expect(control.calls).toEqual([]);
    expect(readFileSync(test.layout.registryFile, "utf8")).toBe(before);
  });

  it("normalizes explicit endpoint and RPC failures without falling back or echoing errors", async () => {
    const test = setup();
    const invalid = await diagnoseHarness(
      { CODEX_CONTROL_SOCKET: "DO_NOT_PRINT" },
      test.layout,
      test.registry,
      { roles: [ROLE] },
    );
    expect(invalid.roles[0]).toMatchObject({
      failed_layer: "adapter",
      endpoint: { path: null, source: "environment" },
    });
    const control = await startFakeControl(test.base, () => ({
      error: { code: -1, message: "DO_NOT_PRINT" },
    }));
    controls.push(control);
    const failed = await diagnoseHarness(
      { CODEX_CONTROL_SOCKET: control.path },
      test.layout,
      test.registry,
      { roles: [ROLE] },
    );
    expect(failed.roles[0]).toMatchObject({
      failed_layer: "frontend",
      layers: { service: { status: "available" }, frontend: { code: "thread_read_unavailable" } },
    });
    expect(JSON.stringify([invalid, failed])).not.toContain("DO_NOT_PRINT");
  });

  it("uses only exact Claude session listings without inferring a connected channel", async () => {
    const test = setup("claude", "active", "prototype-approved");
    const binary = join(test.base, "claude.mjs");
    const calls = join(test.base, "calls.json");
    writeFileSync(
      binary,
      `#!${process.execPath}\n` +
        `import {writeFileSync} from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\n` +
        `console.log(JSON.stringify([{sessionId:${JSON.stringify(CLAUDE_TECH)},` +
        `status:'idle',body:'DO_NOT_PRINT'}]));\n`,
      { mode: 0o755 },
    );
    const report = await diagnoseHarness(
      { CLAUDE_BIN: binary, CODEX_CONTROL_SOCKET: "/never/connect", PRIVATE_AUTH: "DO_NOT_PRINT" },
      test.layout,
      test.registry,
      { roles: [ROLE] },
    );
    expect(JSON.parse(readFileSync(calls, "utf8"))).toEqual(["agents", "--json"]);
    expect(report.roles[0]).toMatchObject({
      effective_harness: "claude",
      native_id: CLAUDE_TECH,
      endpoint: { source: "agents_listing" },
      layers: {
        service: { status: "available" },
        frontend: { status: "available" },
        channel: { status: "unknown" },
        bridge: { status: "unknown" },
      },
      activation: "unknown",
      native_hold: "unknown",
    });
    const channel = join(test.layout.varDir, "wake", "roles", `${ROLE}.json`);
    expect(report.roles[0]?.channel_reference).toEqual({ path: channel, source: "wake_file" });
    expect(existsSync(channel)).toBe(false);
    expect(JSON.stringify(report)).not.toContain("DO_NOT_PRINT");
  });

  it("validates the complete explicit scope before any probe", async () => {
    const test = setup();
    const control = await startFakeControl(test.base, () => ({ result: {} }));
    controls.push(control);
    const env = { CODEX_CONTROL_SOCKET: control.path };
    await expect(diagnoseHarness(env, test.layout, test.registry, {})).rejects.toThrow();
    await expect(
      diagnoseHarness(env, test.layout, test.registry, { roles: [ROLE, "unknown"] }),
    ).rejects.toThrow();
    expect(control.calls).toEqual([]);
  });

  it("compares the Claude channel command with the stable path and reports the server's own status", async () => {
    const test = setup("claude");
    const env = { CLAUDE_BIN: "/never/run" };
    const row = async () =>
      (await diagnoseHarness(env, test.layout, test.registry, { roles: [ROLE] })).roles[0]!;
    expect((await row()).channel_command).toMatchObject({
      code: "channel_config_missing",
      status: "unknown",
    });
    expect((await row()).channel_server).toMatchObject({
      code: "status_file_missing",
      status: "unknown",
      version: null,
    });
    const config = join(test.root, "var", "claude-channel.mcp.json");
    const server = (command: string, args: string[]) =>
      writeFileSync(
        config,
        JSON.stringify({ mcpServers: { "delivery-kit-monitor": { args, command } } }),
      );
    server("npx", ["--no-install", "coordination-kit", "--root", test.root, "claude", "channel"]);
    expect((await row()).channel_command).toMatchObject({
      code: "command_not_stable_path",
      server: "delivery-kit-monitor",
      status: "unstable",
    });
    const [node, ...args] = stableChannelCommand(test.root);
    server(node!, args);
    expect((await row()).channel_command).toMatchObject({
      code: "stable_path",
      command: stableChannelCommand(test.root),
      status: "stable",
    });
    writeChannelStatus(test.layout, {
      argv: stableChannelCommand(test.root),
      conversation: CLAUDE_TECH,
      distSha256: "a".repeat(64),
      pid: 4242,
      role: ROLE,
      schema: 2,
      startedAt: "2026-11-18T15:00:00.000Z",
      version: "2.0.0",
    });
    expect((await row()).channel_server).toEqual({
      argv: stableChannelCommand(test.root),
      code: "status_file_read",
      distSha256: "a".repeat(64),
      pid: 4242,
      startedAt: "2026-11-18T15:00:00.000Z",
      status: "reported",
      version: "2.0.0",
    });
    expect(readFileSync(config, "utf8")).toContain("delivery-kit-monitor");
  });
});
