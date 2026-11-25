// The stdio MCP channel server, driven as a Claude Code client drives it: it emits one wake
// notification per increase of its role's wake file seq, follows the role across a rebind and
// never carries a payload.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

import { ARCHIE, Channel, CHIBI, claudeGame } from "../lib/claude-fixture.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import type { Workspace } from "../lib/workspace.ts";

function wake(ws: Workspace, seq: number, count: number, role = "game-coordinator"): void {
  const directory = join(ws.coordinator, "var", "wake", "roles");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${role}.json`), JSON.stringify({ count, role, schema: 1, seq }));
}

const ROTATED = "00000000-0000-4000-8000-0000000000f1";

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
    wake(ws, 2, 3, "archie-tech");
    await channel.collect(300);
    wake(ws, 2, 3);
    await channel.waitFor(() => channel.channel().length === 2);
    // The /clear rebind rotates the role's conversation; the running channel still serves it.
    ws.writeRegistry({
      schema: 1,
      revision: 2,
      harness: "claude",
      roles: {
        "game-coordinator": { conversations: { claude: ROTATED } },
        "archie-tech": { conversations: { claude: ARCHIE } },
        "chibi-tech": { conversations: { claude: CHIBI } },
      },
    });
    wake(ws, 3, 1);
    await channel.waitFor(() => channel.channel().length === 3);
    expect(channel.channel().map((message) => message.params)).toEqual([
      {
        content: "2 new messages for game-coordinator: run coordination-kit inbox",
        meta: { kind: "wake", seq: "1" },
      },
      {
        content: "3 new messages for game-coordinator: run coordination-kit inbox",
        meta: { kind: "wake", seq: "2" },
      },
      {
        content: "1 new messages for game-coordinator: run coordination-kit inbox",
        meta: { kind: "wake", seq: "3" },
      },
    ]);
    expect((await channel.close()).code).toBe(0);
  });
});
