import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, it } from "vitest";

import type { RpcClient } from "../adapters/codex/rpc.ts";
import { decisionDirectory } from "../adapters/shared/decisions.ts";
import { EXIT_INVALID, EXIT_OK, main } from "../cli.ts";
import { holdLock } from "../lock.ts";
import { updateRegistry } from "../registry/store.ts";
import { ownerDecisionMarker, resolveOwnerDecision } from "./decisionMarkerService.ts";
import { ART, GAME, storeFixture, TECH } from "./testStore.ts";

const ROLE = `${GAME}/art`;
const REPLY = {
  answer_item_id: "answer-item",
  answer_turn_id: "past-turn",
  question_item_id: "question-item",
  question_turn_id: "past-turn",
};
const QUESTIONS = {
  delivery: "async",
  id: REPLY.question_item_id,
  questions: [{ title: "First choice" }, { title: "Second choice" }],
  type: "agentMessage",
};
const INDEPENDENT = {
  answer_item_id: "unrelated-answer",
  answer_turn_id: "unrelated-turn",
  question_item_id: "unrelated-question",
  question_turn_id: "unrelated-turn",
};

function proofReply(count = 2, id = REPLY.answer_item_id) {
  return {
    clientId: "11223344-5566-4777-8899-aabbccddeeff",
    content: [
      {
        text: `<send_user_message_question_reply>\n${JSON.stringify(
          QUESTIONS.questions.slice(0, count).map(({ title }, index) => ({
            answer: "Synthetic answer",
            question: title,
            questionItemId: JSON.stringify(["request_user_input_async", QUESTIONS.id, index]),
          })),
        )}\n</send_user_message_question_reply>`,
        text_elements: [],
        type: "text",
      },
    ],
    id,
    type: "userMessage",
  };
}

function setup(raw: Record<string, unknown> = {}) {
  const { base, layout, root } = storeFixture();
  const directory = join(decisionDirectory(layout, ROLE)!, "decisions");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${ART}.json`);
  const marker = {
    resolutions: [
      { answer_reference: "legacy-reference", question_item_id: QUESTIONS.id },
      INDEPENDENT,
    ],
    state: "clear",
    thread_id: ART,
    ...raw,
  };
  writeFileSync(path, JSON.stringify(marker));
  const historical: unknown[] = [QUESTIONS, proofReply()];
  const current: unknown[] = [{ id: "current-tool", type: "commandExecution" }];
  const allowedMethods: string[] = [];
  let beforeReply: ((method: string) => void) | undefined;
  let active = true;
  const client: RpcClient = {
    call(method, params) {
      allowedMethods.push(method);
      beforeReply?.(method);
      if (method === "thread/read") {
        return Promise.resolve({
          thread: {
            canAcceptDirectInput: true,
            id: ART,
            parentThreadId: null,
            source: "cli",
            status: active ? { activeFlags: [], type: "active" } : { type: "idle" },
          },
        });
      }
      if (method === "thread/turns/list") {
        return Promise.resolve({
          data: [{ id: "head", status: active ? "inProgress" : "completed" }],
        });
      }
      if (method === "thread/items/list") {
        const { turnId } = params as { turnId: string };
        const items = turnId === REPLY.question_turn_id ? historical : current;
        return Promise.resolve({ data: items.map((item) => ({ item, threadId: ART, turnId })) });
      }
      throw new Error("Unexpected native method");
    },
    close() {},
  };
  const context = {
    env: { CODEX_THREAD_ID: ART },
    layout,
    ports: { connect: () => Promise.resolve(client) },
  };
  const { digest, revision } = ownerDecisionMarker(context);
  const input = { digest, resolution: REPLY, revision };
  return {
    allowedMethods,
    base,
    context,
    current,
    historical,
    input,
    marker,
    path,
    root,
    before(fn: (method: string) => void) {
      beforeReply = fn;
    },
    idle() {
      active = false;
    },
  };
}

it("repairs exactly one legacy entry from an active owner turn and preserves independent data", async () => {
  const { allowedMethods, context, input, marker, path } = setup({ note: "preserve" });
  expect(ownerDecisionMarker(context)).toMatchObject({
    fields: ["question_turn_id", "answer_turn_id", "answer_item_id"],
    state: "invalid",
  });
  const result = await resolveOwnerDecision(context, input);
  expect(result).toMatchObject({ outcome: "written", revision: input.revision, role: ROLE });
  const written = readFileSync(path, "utf8");
  expect(JSON.parse(written)).toEqual({
    ...marker,
    resolutions: [{ ...marker.resolutions[0], ...REPLY }, INDEPENDENT],
  });
  expect(new Set(allowedMethods)).toEqual(
    new Set(["thread/read", "thread/turns/list", "thread/items/list"]),
  );
  await expect(resolveOwnerDecision(context, input)).rejects.toThrow("decision-marker-stale");
  expect(await resolveOwnerDecision(context, { ...input, digest: result.digest })).toMatchObject({
    outcome: "unchanged",
  });
  expect(readFileSync(path, "utf8")).toBe(written);
});

it("fills the matching legacy row's three null references only from exact proof", async () => {
  const legacy = {
    answer_item_id: null,
    answer_turn_id: null,
    question_item_id: QUESTIONS.id,
    question_turn_id: null,
  };
  const { context, input, path } = setup({ resolutions: [legacy, INDEPENDENT] });
  expect(await resolveOwnerDecision(context, input)).toMatchObject({ outcome: "written" });
  expect(JSON.parse(readFileSync(path, "utf8")).resolutions).toEqual([REPLY, INDEPENDENT]);
});

it.each([
  {
    code: "decision-resolution-conflict",
    rows: [{ ...REPLY, question_turn_id: "different-turn" }, INDEPENDENT],
  },
  {
    code: "decision-marker-invalid",
    rows: [REPLY, { ...INDEPENDENT, answer_item_id: null }],
  },
])("refuses $code without altering any row", async ({ code, rows }) => {
  const { context, input, path } = setup({ resolutions: rows });
  const before = readFileSync(path);
  await expect(resolveOwnerDecision(context, input)).rejects.toThrow(code);
  expect(readFileSync(path)).toEqual(before);
});

it("keeps an explicit pending owner marker pending while recording a verified reply", async () => {
  const { context, idle, input, path } = setup({ state: "pending" });
  idle();
  await expect(resolveOwnerDecision(context, input)).resolves.toMatchObject({ outcome: "written" });
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
    resolutions: [expect.objectContaining(REPLY), INDEPENDENT],
    state: "pending",
  });
});

it("rejects an old registry revision and a different owner before reading native items", async () => {
  const { allowedMethods, context, input } = setup();
  await expect(
    resolveOwnerDecision({ ...context, env: { CODEX_THREAD_ID: TECH } }, input),
  ).rejects.toThrow();
  updateRegistry(context.layout, input.revision, (draft) => draft);
  await expect(resolveOwnerDecision(context, input)).rejects.toThrow("decision-marker-stale");
  expect(allowedMethods).toEqual([]);
});

it("preserves a concurrent marker update after native verification starts", async () => {
  const { before, context, input, marker, path } = setup();
  const changed = JSON.stringify({ ...marker, state: "pending" });
  before(() => writeFileSync(path, changed));
  await expect(resolveOwnerDecision(context, input)).rejects.toThrow("decision-marker-stale");
  expect(readFileSync(path, "utf8")).toBe(changed);
});

it("refuses without writing while the marker writer lock is held", async () => {
  const { context, input, path } = setup();
  const original = readFileSync(path);
  const lock = holdLock(join(context.layout.varDir, `decision-${ART}.lock`));
  try {
    await expect(resolveOwnerDecision(context, input)).rejects.toThrow("decision-marker-busy");
    expect(readFileSync(path)).toEqual(original);
  } finally {
    lock.release();
  }
});

it.each(["partial reply", "ambiguous reply", "unresolved current prompt"])(
  "leaves marker bytes intact for %s",
  async (failure) => {
    const { context, current, historical, input, path } = setup();
    if (failure === "partial reply") {
      historical[1] = proofReply(1);
    }
    if (failure === "ambiguous reply") {
      historical.push(proofReply(2, "second-reply"));
    }
    if (failure === "unresolved current prompt") {
      current.push({ ...QUESTIONS, id: "pending" });
    }
    const original = readFileSync(path);
    await expect(resolveOwnerDecision(context, input)).rejects.toThrow(
      "decision-native-proof-unavailable",
    );
    expect(readFileSync(path)).toEqual(original);
  },
);

it("exposes only owner marker metadata and forbids caller override at the CLI boundary", async () => {
  const { base, context, input, root } = setup();
  const run = async (...args: string[]) => {
    let output = "";
    const code = await main(
      {
        cwd: base,
        env: context.env,
        err: () => {},
        out: (text) => {
          output += text;
        },
      },
      ["--root", root, ...args],
    );
    return { code, output };
  };
  const readback = await run("decision", "marker");
  expect(readback.code).toBe(EXIT_OK);
  expect(JSON.parse(readback.output)).toEqual(ownerDecisionMarker(context));
  expect(readback.output).not.toContain("legacy-reference");
  expect(
    await run(
      "decision",
      "resolve",
      "--expect",
      input.digest,
      "--expect-revision",
      String(input.revision),
      "--answer-item",
      REPLY.answer_item_id,
      "--answer-turn",
      REPLY.answer_turn_id,
      "--question-item",
      REPLY.question_item_id,
      "--question-turn",
      REPLY.question_turn_id,
      "--native-id",
      ART,
    ),
  ).toMatchObject({ output: "" });
  const absent = await run(
    "decision",
    "resolve",
    "--expect",
    "absent",
    "--expect-revision",
    String(input.revision),
    "--answer-item",
    REPLY.answer_item_id,
    "--answer-turn",
    REPLY.answer_turn_id,
    "--question-item",
    REPLY.question_item_id,
    "--question-turn",
    REPLY.question_turn_id,
  );
  expect(absent).toEqual({ code: EXIT_INVALID, output: "" });
});
