import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { serve } from "./channel.ts";
import { WakeWatcher } from "./wakeFile.ts";

describe("protocol", () => {
  it("answers initialize, ping and unknown requests, and wakes only after initialization", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ck-channel-")), "wake.json");
    writeFileSync(path, JSON.stringify({ count: 1, role: "game-coordinator", schema: 1, seq: 1 }));
    const input = new PassThrough();
    const lines: string[] = [];
    const done = serve(
      { pollMs: 3_600_000, wake: new WakeWatcher(() => path) },
      input,
      (line) => void lines.push(line),
    );
    const requests = [
      { id: 1, method: "initialize", params: {} },
      { id: 2, method: "ping" },
      { id: 3, method: "tools/list" },
    ];
    input.write(requests.map((request) => `${JSON.stringify(request)}\n`).join(""));
    await vi.waitFor(() => expect(lines).toHaveLength(3));
    // Each message drains the wake; none is emitted before notifications/initialized.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(lines).toHaveLength(3);
    input.write(`${JSON.stringify({ method: "notifications/initialized" })}\n`);
    await vi.waitFor(() => expect(lines).toHaveLength(4));
    input.end();
    expect(await done).toBe(0);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toMatchObject([
      { id: 1, result: { serverInfo: { name: "delivery-kit-channel" } } },
      { id: 2, result: {} },
      { error: { code: -32601 }, id: 3 },
      {
        method: "notifications/claude/channel",
        params: {
          content: "1 new messages for game-coordinator: run coordination-kit inbox",
          meta: { kind: "wake", seq: "1" },
        },
      },
    ]);
  });
});
