import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";

import { execute, impl } from "../lib/adapter.ts";
import { contract, suite, workspaces } from "../lib/cases.ts";
import { CodexSocket } from "../lib/codex-socket.ts";
import { NativeWorld } from "../lib/unblock-native.ts";
import type { Workspace } from "../lib/workspace.ts";

const COORDINATOR = "00000000-0000-4000-8000-0000000000a1";
const TECH = "00000000-0000-4000-8000-0000000000a2";
const ART = "00000000-0000-4000-8000-0000000000a3";
const BODY = "Store contract body.\n";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function configure(ws: Workspace): void {
  ws.writeRegistry({
    harness: "claude",
    revision: 1,
    roles: {
      [`${ws.game}/art`]: { conversations: { codex: ART }, harness: "codex" },
      [`${ws.game}/tech`]: { conversations: { claude: TECH } },
      "game-coordinator": { conversations: { claude: COORDINATOR } },
    },
    schema: 1,
  });
  writeFileSync(join(ws.coordinator, "body.txt"), BODY);
}

async function run(ws: Workspace, env: Record<string, string>, words: string[]) {
  const command = impl.bare(ws, words);
  command.env = { ...command.env, ...env };
  const result = await execute(command);
  expect(result.code, `${words.join(" ")}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

/** The lifecycle as one recipient sees it, with role, IDs and times replaced by placeholders. */
async function lifecycle(
  ws: Workspace,
  role: string,
  recipient: Record<string, string>,
  id: string,
) {
  const sender = { CLAUDE_CODE_SESSION_ID: COORDINATOR };
  const outputs = [
    await run(ws, sender, [
      "msg",
      "send",
      "--to",
      role,
      "--body-file",
      "body.txt",
      "--id",
      id,
      "--link",
      "work=ck-0017",
    ]),
    await run(ws, sender, [
      "msg",
      "send",
      "--to",
      role,
      "--body-file",
      "body.txt",
      "--id",
      id,
      "--link",
      "work=ck-0017",
    ]),
    await run(ws, recipient, ["inbox", "--include-body"]),
    await run(ws, recipient, ["inbox"]),
    await run(ws, recipient, [
      "msg",
      "retain",
      id,
      "--reason",
      "waiting",
      "--next-boundary",
      "next review",
    ]),
    await run(ws, recipient, [
      "msg",
      "done",
      id,
      "--work",
      "ck-0017",
      "--evidence",
      "commit:abc123",
    ]),
    await run(ws, recipient, [
      "msg",
      "done",
      id,
      "--work",
      "ck-0017",
      "--evidence",
      "commit:abc123",
    ]),
    await run(ws, sender, ["msg", "status", id]),
    await run(ws, sender, ["msg", "history", "--role", role]),
  ];
  return JSON.parse(
    JSON.stringify(outputs)
      .replaceAll(role, "ROLE")
      .replaceAll(id, "ID")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "AT")
      .replace(/"wake":"[0-9a-f-]{36}"/g, '"wake":"WAKE-ID"')
      .replace(/"seq":\d+/g, '"seq":0'),
  ) as unknown;
}

suite("store messages", () => {
  const workspace = workspaces();

  contract("the same lifecycle and output on the Claude and Codex adapters", async () => {
    const ws = workspace();
    configure(ws);
    const world = new NativeWorld();
    const thread = world.thread(ART);
    thread.status = { type: "idle" };
    thread.turn = { id: "turn-one", status: "completed" };
    thread.read = { id: ART, parentThreadId: null, source: "cli" };
    const socket = await new CodexSocket(ws).listen();
    world.install(socket);
    socket.on("thread/queue/add", (params: Record<string, unknown>) => ({
      queuedSubmission: {
        clientUserMessageId: params.clientUserMessageId,
        id: "queue-1",
        input: params.input,
      },
    }));
    ws.env.CODEX_CONTROL_SOCKET = socket.path;
    try {
      const claude = await lifecycle(
        ws,
        `${ws.game}/tech`,
        { CLAUDE_CODE_SESSION_ID: TECH },
        uuid(1),
      );
      const codex = await lifecycle(ws, `${ws.game}/art`, { CODEX_THREAD_ID: ART }, uuid(2));
      expect(codex).toEqual(claude);
      expect(claude).toMatchObject([
        { duplicate: false, message: { state: "sent" }, wake: { status: "accepted" } },
        { duplicate: true, wake: { status: "coalesced" } },
        { delivered: 1, messages: [{ body: BODY, state: "delivered" }] },
        { delivered: 0, messages: [{ state: "delivered" }] },
        {
          message: {
            retention: { nextBoundary: "next review", owner: "ROLE", reason: "waiting" },
            state: "retained",
          },
        },
        {
          duplicate: false,
          message: { evidence: ["commit:abc123"], state: "handled", work: "ck-0017" },
        },
        { duplicate: true },
        { message: { state: "handled" } },
        {},
      ]);

      // Each adapter woke its recipient once, with the fixed text and no payload.
      const wakeFile = join(ws.coordinator, "var", "wake", "roles", ws.game, "tech.json");
      expect(existsSync(wakeFile)).toBe(true);
      expect(JSON.parse(readFileSync(wakeFile, "utf8"))).toEqual({
        count: 1,
        role: `${ws.game}/tech`,
        schema: 1,
        seq: 1,
      });
      const adds = socket.callsOf("thread/queue/add");
      expect(adds.map((call) => call.params.input)).toEqual([
        [
          {
            text: `1 new messages for ${ws.game}/art: run coordination-kit inbox`,
            text_elements: [],
            type: "text",
          },
        ],
      ]);
      expect(JSON.stringify(socket.calls)).not.toContain("Store contract body");
      expect(socket.methods().filter((method) => method.startsWith("turn/"))).toEqual([]);
    } finally {
      await socket.close();
    }
  });

  contract("keeps a caller with a mismatched binding unbound", async () => {
    const ws = workspace();
    configure(ws);
    const command = impl.bare(ws, ["msg", "send", "--to", `${ws.game}/tech`, "--body", "x"]);
    // Art's Codex ID in the Claude variable binds no role.
    command.env = { ...command.env, CLAUDE_CODE_SESSION_ID: ART };
    const result = await execute(command);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      message: { from: "[unbound]", intent: "queue", to: `${ws.game}/tech` },
    });
  });
});
