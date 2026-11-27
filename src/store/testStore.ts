// Scratch coordinator trees with a registry for the store tests. Synthetic IDs only.
import type { RpcClient } from "../adapters/codex/rpc.ts";
import { type Layout, loadLayout } from "../core/configuration/layout.ts";
import { makeFixture, TEST_CLOCK } from "../core/testFixtures.ts";
import { createRegistry, type Registry } from "../registry/index.ts";

export const COORDINATOR = "00000000-0000-4000-8000-0000000000c1";
export const TECH = "00000000-0000-4000-8000-0000000000c2";
export const TECH_CODEX = "00000000-0000-4000-8000-0000000000d2";
export const ART = "00000000-0000-4000-8000-0000000000d3";
export const GAMEPLAY = "00000000-0000-4000-8000-0000000000c4";
export const GAME = "archies-dog-walks";

interface StoreFixture {
  readonly root: string;
  readonly base: string;
  readonly layout: Layout;
}

/**
 * Roles: game-coordinator and tech on Claude, art on Codex (an override), gameplay on Claude and
 * held. The registry default harness is Claude.
 */
export function storeFixture(
  change?: (roles: Record<string, Record<string, unknown>>) => void,
): StoreFixture {
  const { base, root } = makeFixture();
  const layout = loadLayout(root);
  const roles: Record<string, Record<string, unknown>> = {
    [`${GAME}/art`]: {
      conversations: { codex: ART },
      harness: "codex",
      ownership: "active",
      worktree: "../archies-dog-walks/.worktrees/art",
    },
    [`${GAME}/gameplay`]: {
      conversations: { claude: GAMEPLAY },
      ownership: "active",
      phase: "held",
      worktree: "../archies-dog-walks/.worktrees/gameplay",
    },
    [`${GAME}/tech`]: {
      conversations: { claude: TECH, codex: TECH_CODEX },
      ownership: "active",
      worktree: "../archies-dog-walks/.worktrees/tech",
    },
    "game-coordinator": {
      conversations: { claude: COORDINATOR },
      ownership: "active",
      worktree: ".",
    },
  };
  change?.(roles);
  createRegistry(TEST_CLOCK, layout, {
    harness: "claude",
    host: { nativeProjectId: "project-1", root: "." },
    operations: {},
    roles,
    schema: 1,
    transfers: [],
  } as unknown as Omit<Registry, "revision" | "updatedAt">);
  return { base, layout, root };
}

interface FakeCodex {
  readonly client: RpcClient;
  readonly calls: { readonly method: string; readonly params: Record<string, unknown> }[];
  adds(): Record<string, unknown>[];
}

/** An idle, question-free root thread whose queue add answers per `add`. */
export function fakeCodex(
  conversation: string,
  add: (params: Record<string, unknown>) => unknown = (params) => ({
    queuedSubmission: {
      clientUserMessageId: params.clientUserMessageId,
      id: `queue-${String(params.clientUserMessageId)}`,
      input: params.input,
    },
  }),
  source = "cli",
): FakeCodex {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client: RpcClient = {
    call(method, raw) {
      const params = (raw ?? {}) as Record<string, unknown>;
      calls.push({ method, params });
      switch (method) {
        case "thread/read":
          return Promise.resolve({
            thread: {
              canAcceptDirectInput: true,
              id: conversation,
              parentThreadId: null,
              source,
              status: { type: "idle" },
            },
          });
        case "thread/turns/list":
          return Promise.resolve({ data: [{ id: "turn-1", status: "completed" }] });
        case "thread/items/list":
          return Promise.resolve({
            data: [
              { item: { id: "item-1", questions: null, type: "agentMessage" }, turnId: "turn-1" },
            ],
          });
        case "thread/queue/list":
          return Promise.resolve({ data: [] });
        case "thread/queue/add":
          return Promise.resolve().then(() => add(params));
        default:
          return Promise.reject(new Error(`unexpected ${method}`));
      }
    },
    close() {},
  };
  return {
    adds: () =>
      calls.filter((call) => call.method === "thread/queue/add").map((call) => call.params),
    calls,
    client,
  };
}
