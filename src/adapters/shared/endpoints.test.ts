import { statSync } from "node:fs";
import { homedir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Layout } from "../../layout.ts";
import type { Registry } from "../../registry/schema.ts";
import { effectiveReadiness, harnessReadiness } from "../../review/readiness.ts";
import { coordinatorConfig, registryInput } from "../../testFixtures.ts";
import { connectControl } from "../codex/rpc.ts";
import { resolveCodexControlSocket } from "./endpoints.ts";

const SOCKET_MISSING =
  "set CODEX_CONTROL_SOCKET to an available absolute Codex control socket path";
const MANAGED = "/managed-home/.codex/app-server-control/app-server-control.sock";
const SCOPE = { roles: ["archies-dog-walks/tech"] };
const LAYOUT = { config: coordinatorConfig() } as unknown as Layout;
const REGISTRY = { ...registryInput(), harness: "codex" } as unknown as Registry;

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: vi.fn(() => "/managed-home"),
}));

vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  statSync: vi.fn(() => ({ isSocket: () => true })),
}));

vi.mock("../codex/rpc.ts", async (original) => ({
  ...(await original<typeof import("../codex/rpc.ts")>()),
  connectControl: vi.fn(() => {
    throw new Error("unexpected native connection");
  }),
}));

beforeEach(() => vi.clearAllMocks());

describe("Codex endpoint selection", () => {
  it("preserves an explicit option over environment and managed paths without inspecting it", () => {
    expect(
      resolveCodexControlSocket({
        controlSocket: "/chosen/not-created.sock",
        env: { CODEX_CONTROL_SOCKET: "/environment.sock" },
        home: "/other-home",
      }),
    ).toEqual({ path: "/chosen/not-created.sock", source: "option" });
    expect(statSync).not.toHaveBeenCalled();
    expect(homedir).not.toHaveBeenCalled();
  });

  it.each([
    ["empty option", { controlSocket: "", env: { CODEX_CONTROL_SOCKET: "/environment.sock" } }],
    ["relative environment", { env: { CODEX_CONTROL_SOCKET: "relative.sock" } }],
  ] as const)("rejects %s without falling back or exposing the value", (_name, options) => {
    expect(() => resolveCodexControlSocket({ ...options, home: "/other-home" })).toThrowError(
      /^Codex control socket must be a nonempty absolute path without NUL bytes$/,
    );
    expect(homedir).not.toHaveBeenCalled();
    expect(statSync).not.toHaveBeenCalled();
  });

  it("selects the managed home default only when explicit configuration is absent", () => {
    expect(resolveCodexControlSocket({ env: {} })).toEqual({
      path: MANAGED,
      source: "managed",
    });
    expect(statSync).not.toHaveBeenCalled();
    expect(connectControl).not.toHaveBeenCalled();
  });

  it("uses the same managed socket for direct and mixed readiness", async () => {
    const close = vi.fn();
    const call = vi.fn();
    vi.mocked(connectControl).mockResolvedValueOnce({ call, close }).mockResolvedValueOnce({
      call,
      close,
    });
    const direct = await harnessReadiness({}, LAYOUT, REGISTRY, "codex", SCOPE);
    const mixed = await effectiveReadiness({}, LAYOUT, REGISTRY, SCOPE);

    expect(direct.ready).toBe(true);
    expect(mixed.ready).toBe(true);
    expect(mixed.adapters.codex).toEqual(direct.adapter);
    expect(statSync).toHaveBeenCalledTimes(2);
    expect(connectControl).toHaveBeenNthCalledWith(1, expect.any(Number), MANAGED);
    expect(connectControl).toHaveBeenNthCalledWith(2, expect.any(Number), MANAGED);
    expect(close).toHaveBeenCalledTimes(2);
    expect(call).not.toHaveBeenCalled();
  });

  it.each(["", "relative.sock", "/explicit\0socket"])(
    "refuses an invalid socket override without managed discovery",
    async (value) => {
      const result = await harnessReadiness(
        { CODEX_CONTROL_SOCKET: value },
        LAYOUT,
        REGISTRY,
        "codex",
        SCOPE,
      );
      expect(result.adapter).toEqual({ reason: SOCKET_MISSING, status: "unavailable" });
      expect(result.ready).toBe(false);
      expect(homedir).not.toHaveBeenCalled();
      expect(statSync).not.toHaveBeenCalled();
      expect(connectControl).not.toHaveBeenCalled();
    },
  );

  it("refuses a missing configured socket without trying the managed socket", async () => {
    vi.mocked(statSync).mockImplementationOnce(() => {
      throw new Error("missing socket");
    });
    const result = await effectiveReadiness(
      { CODEX_CONTROL_SOCKET: "/explicit/missing.sock" },
      LAYOUT,
      REGISTRY,
      SCOPE,
    );
    expect(result.adapters.codex).toEqual({ reason: SOCKET_MISSING, status: "unavailable" });
    expect(result.ready).toBe(false);
    expect(statSync).toHaveBeenCalledExactlyOnceWith("/explicit/missing.sock");
    expect(homedir).not.toHaveBeenCalled();
    expect(connectControl).not.toHaveBeenCalled();
  });

  it("reports a missing managed socket without requiring an environment override", async () => {
    vi.mocked(statSync).mockImplementationOnce(() => {
      throw new Error("missing socket");
    });
    const result = await harnessReadiness({}, LAYOUT, REGISTRY, "codex", SCOPE);
    expect(result.adapter).toEqual({
      reason: "the managed Codex control socket is unavailable",
      status: "unavailable",
    });
    expect(result.ready).toBe(false);
    expect(statSync).toHaveBeenCalledExactlyOnceWith(MANAGED);
    expect(connectControl).not.toHaveBeenCalled();
  });

  it("does not fall back when the explicitly configured socket refuses a probe", async () => {
    const result = await harnessReadiness(
      { CODEX_CONTROL_SOCKET: "/explicit/refused.sock" },
      LAYOUT,
      REGISTRY,
      "codex",
      SCOPE,
    );
    expect(result.adapter).toEqual({
      reason: "the Codex control socket refused the connection",
      status: "unavailable",
    });
    expect(result.ready).toBe(false);
    expect(connectControl).toHaveBeenCalledExactlyOnceWith(
      expect.any(Number),
      "/explicit/refused.sock",
    );
    expect(homedir).not.toHaveBeenCalled();
  });
});
