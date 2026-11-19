import { describe, expect, it } from "vitest";

import { handle } from "./channel.ts";

describe("protocol", () => {
  it("answers initialize, ping and unknown requests", () => {
    const lines: string[] = [];
    const write = (line: string): void => void lines.push(line);
    expect(handle(write, { id: 1, method: "initialize", params: {} })).toBe(false);
    expect(handle(write, { id: 2, method: "ping" })).toBe(false);
    expect(handle(write, { id: 3, method: "tools/list" })).toBe(false);
    expect(handle(write, { method: "notifications/initialized" })).toBe(true);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
      { id: 1, result: { serverInfo: { name: "delivery-kit-channel" } } },
      { id: 2, result: {} },
      { error: { code: -32601 }, id: 3 },
    ]);
  });
});
