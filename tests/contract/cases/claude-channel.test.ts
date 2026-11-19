// The stdio MCP channel server, driven as a Claude Code client drives it: it emits one wake
// notification per increase of the conversation's wake file seq and never carries a payload.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { ARCHIE, Channel, claudeGame, RECIPIENT } from "../lib/claude-fixture.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import type { Workspace } from "../lib/workspace.ts";

function wake(ws: Workspace, seq: number, count: number, conversation = RECIPIENT): void {
  const directory = join(ws.coordinator, "var", "wake");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${conversation}.json`),
    JSON.stringify({ count, role: "game-coordinator", schema: 1, seq }),
  );
}

suite("claude channel server", () => {
  const workspace = workspaces();

  contract("emits one wake per seq increase, only after initialization", async () => {
    const ws = workspace();
    claudeGame(ws);
    const channel = Channel.open(ws);
    channel.initialize();
    await channel.collect(300);
    expect(channel.messages[0]!.result.capabilities).toEqual({
      experimental: { "claude/channel": {} },
    });
    wake(ws, 1, 2);
    await channel.collect(300);
    expect(channel.channel()).toEqual([]);
    channel.initialized();
    await channel.waitFor(() => channel.channel().length === 1);
    wake(ws, 1, 2);
    wake(ws, 2, 3, ARCHIE);
    await channel.collect(300);
    wake(ws, 2, 3);
    await channel.waitFor(() => channel.channel().length === 2);
    expect(channel.channel().map((message) => message.params)).toEqual([
      {
        content: "2 new messages for game-coordinator: run coordination-kit inbox",
        meta: { kind: "wake", seq: "1" },
      },
      {
        content: "3 new messages for game-coordinator: run coordination-kit inbox",
        meta: { kind: "wake", seq: "2" },
      },
    ]);
    expect((await channel.close()).code).toBe(0);
  });
});
