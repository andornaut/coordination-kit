import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { main } from "../../cli.ts";
import { EXIT_INVALID, EXIT_OK, EXIT_USAGE } from "../../core/cli/io.ts";
import { loadLayout } from "../../core/configuration/layout.ts";
import { TEST_CONTEXT } from "../../core/testFixtures.ts";
import { Store, storePath } from "../../store/db.ts";
import { sha256 } from "../../store/eventCodec.ts";
import { openFileJournal } from "../../store/files/journal.ts";
import { sendMessage } from "../../store/messages/messages.ts";
import { ART, COORDINATOR, GAMEPLAY, storeFixture, TECH } from "../../store/testStore.ts";
import { UNBOUND_MESSAGE_SENDER } from "../../store/types.ts";

const ID = "00000000-0000-4000-8000-000000000301";
const TECH_ROLE = "archies-dog-walks/tech";
const ART_ROLE = "archies-dog-walks/art";

function cli(root: string, cwd: string, env: NodeJS.ProcessEnv) {
  return async (...argv: string[]) => {
    let out = "";
    let err = "";
    const code = await main(
      { cwd, env, err: (text) => (err += text), out: (text) => (out += text) },
      ["--root", root, ...argv],
    );
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(out) as Record<string, unknown>;
    } catch {
      // Help and usage text are not JSON.
    }
    return { code, err, json, out };
  };
}

describe("store compaction-plan", () => {
  it("requires active filesystem authority and refuses apply arguments", async () => {
    const { base, layout, root } = storeFixture();
    const run = cli(root, base, {});
    expect(await run("store", "compaction-plan")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: compaction-file-authority-required\n",
    });
    expect(await run("store", "compaction-plan", "--apply")).toMatchObject({
      code: EXIT_USAGE,
    });
    expect(existsSync(storePath(layout))).toBe(false);
  });

  it("reports the selected journal head without writing files or exposing a body", async () => {
    const { base, layout, root } = storeFixture();
    const store = Store.forLayout(TEST_CONTEXT, layout);
    try {
      sendMessage(
        store,
        { nativeId: COORDINATOR, role: "game-coordinator" },
        { body: "Private fixture original", id: ID, intent: "queue", to: TECH_ROLE },
      );
    } finally {
      store.close();
    }
    const target = storePath(layout);
    const journal = openFileJournal(target);
    const before = journal.snapshot();
    const { hash, seq } = before.events.at(-1)!;
    const paths = readdirSync(target, { recursive: true }).sort();
    const result = await cli(root, base, {})("store", "compaction-plan");
    expect(result).toMatchObject({
      code: EXIT_OK,
      json: {
        diskSavingsBytes: null,
        head: { hash, seq },
        kind: "file-compaction-plan",
        schema: 1,
        window: 100,
      },
    });
    expect(result.out).not.toContain("Private fixture original");
    expect(journal.snapshot()).toEqual(before);
    expect(readdirSync(target, { recursive: true }).sort()).toEqual(paths);
  });
});

describe("store message commands", () => {
  it("keeps an unwoken unblock in the normal unread projection with no coordinator alert", async () => {
    const { base, root } = storeFixture();
    const tech = cli(root, base, { CLAUDE_CODE_SESSION_ID: TECH });
    const coordinator = cli(root, base, { CLAUDE_CODE_SESSION_ID: COORDINATOR });
    const original = await tech(
      "msg",
      "send",
      "--to",
      ART_ROLE,
      "--body",
      "Private transfer details.",
      "--intent",
      "unblock",
      "--link",
      "work=ck-0031",
      "--id",
      ID,
    );
    expect(original).toMatchObject({
      code: EXIT_OK,
      json: { message: { deliveredAt: null, id: ID, state: "sent" }, wake: { status: "failed" } },
    });
    expect(original.json).not.toHaveProperty("attention");
    expect(await coordinator("inbox", "--peek")).toMatchObject({
      code: EXIT_OK,
      json: { count: 0 },
    });
    const art = cli(root, base, { CODEX_THREAD_ID: ART });
    expect(await art("inbox", "--peek")).toMatchObject({
      json: { count: 1, unread: [{ id: ID, wake: { outcome: "failed" } }] },
    });
    expect((await art("inbox", "--include-body")).json).toMatchObject({
      delivered: 1,
      messages: [{ body: "Private transfer details.", id: ID, state: "delivered" }],
    });
  });

  it("reports empty history and export without creating a store", async () => {
    const { base, root } = storeFixture();
    const run = cli(root, base, {});
    expect(await run("msg", "status", ID)).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: missing\n",
    });
    expect(await run("msg", "history")).toMatchObject({
      code: EXIT_OK,
      json: { events: [], schema: 1 },
    });
    expect(await run("store", "export", "--since", "2000-01-01T00:00:00Z")).toMatchObject({
      code: EXIT_OK,
      json: { closes: [], messages: [], schema: 1 },
    });
    expect(existsSync(storePath(loadLayout(root)))).toBe(false);
  });

  it("runs send, inbox, done, status, history, export and rebuild with JSON output", async () => {
    const { base, root } = storeFixture();
    writeFileSync(join(base, "body.txt"), "Exact body.\n\n");
    const coordinator = cli(root, base, { CLAUDE_CODE_SESSION_ID: COORDINATOR });
    const tech = cli(root, base, { CLAUDE_CODE_SESSION_ID: TECH });

    const sent = await coordinator(
      "msg",
      "send",
      "--to",
      TECH_ROLE,
      "--body-file",
      "body.txt",
      "--id",
      ID,
      "--link",
      "work=ck-0017",
    );
    expect(sent.code, sent.err).toBe(EXIT_OK);
    expect(sent.json).toMatchObject({
      duplicate: false,
      message: {
        from: "game-coordinator",
        id: ID,
        links: [{ kind: "work", ref: "ck-0017" }],
        state: "sent",
        to: TECH_ROLE,
      },
      schema: 1,
      wake: { status: "accepted" },
    });
    expect(sent.out).not.toContain("Exact body.");
    const repeated = await coordinator(
      "msg",
      "send",
      "--to",
      TECH_ROLE,
      "--body-file",
      "body.txt",
      "--id",
      ID,
      "--link",
      "work=ck-0017",
    );
    expect(repeated.json).toMatchObject({ duplicate: true, wake: { status: "coalesced" } });
    const generated = await coordinator(
      "msg",
      "send",
      "--to",
      TECH_ROLE,
      "--body",
      "Inline.",
      "--intent",
      "unblock",
    );
    expect((generated.json?.message as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);

    const passive = await tech("inbox", "--peek");
    expect(passive.code, passive.err).toBe(EXIT_OK);
    expect(passive.json).toMatchObject({
      count: 2,
      role: TECH_ROLE,
      unread: [
        { id: ID, wake: { nextAction: "collect-at-safe-boundary", outcome: "accepted" } },
        { wake: { outcome: "coalesced" } },
      ],
    });
    const inbox = await tech("inbox", "--include-body");
    expect(inbox.code, inbox.err).toBe(EXIT_OK);
    expect(inbox.json).toMatchObject({ count: 2, delivered: 2, role: TECH_ROLE, schema: 1 });
    expect((inbox.json?.messages as { body: string }[])[0]?.body).toBe("Exact body.\n\n");

    const done = await tech(
      "msg",
      "done",
      ID,
      "--work",
      "ck-0017",
      "--evidence",
      "commit:abc",
      "--evidence",
      "commit:def",
    );
    expect(done.code, done.err).toBe(EXIT_OK);
    expect(done.json).toMatchObject({
      duplicate: false,
      message: { evidence: ["commit:abc", "commit:def"], state: "handled", work: "ck-0017" },
    });

    const status = await coordinator("msg", "status", ID);
    expect(status.json).toMatchObject({ message: { id: ID, state: "handled" }, schema: 1 });
    expect(status.json?.message).not.toHaveProperty("body");
    const history = await tech("msg", "history", "--role", TECH_ROLE);
    expect((history.json?.events as { kind: string }[]).map((event) => event.kind)).toEqual([
      "msg.sent",
      "msg.sent",
      "inbox.read",
      "msg.closed",
    ]);
    const exported = await tech("store", "export", "--since", "2000-01-01T00:00:00Z");
    expect((exported.json?.messages as unknown[]).length).toBe(2);
    expect((exported.json?.closes as unknown[]).length).toBe(1);
    const rebuilt = await tech("store", "rebuild");
    expect(rebuilt.json).toMatchObject({ events: expect.any(Number), schema: 1, verified: true });
  });

  it("requires one exact user decision for an unbound original across filesystem rebuilds", async () => {
    const { base, layout, root } = storeFixture();
    Store.forLayout(TEST_CONTEXT, layout).close();

    const claimedId = "00000000-0000-4000-8000-0000000000ff";
    const recipientRole = "archies-dog-walks/gameplay";
    const stranger = cli(root, base, {
      CLAUDE_CODE_SESSION_ID: claimedId,
    });
    const recipient = cli(root, base, { CLAUDE_CODE_SESSION_ID: GAMEPLAY });
    const args = ["msg", "send", "--to", recipientRole, "--body", "Original.", "--id", ID];
    expect(await stranger(...args, "--intent", "unblock", "--worker", "claimed")).toMatchObject({
      code: EXIT_OK,
      json: {
        duplicate: false,
        message: {
          from: UNBOUND_MESSAGE_SENDER,
          intent: "queue",
          senderVerification: "unverified",
          worker: null,
        },
        wake: { status: "guarded" },
      },
    });
    expect(await cli(root, base, {})(...args)).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: true },
    });
    expect(await stranger("msg", "status", ID, "--include-body")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: caller-unbound\n",
    });
    expect(await stranger("msg", "done", ID)).toMatchObject({ code: EXIT_INVALID });
    const opened = Store.forLayout(TEST_CONTEXT, layout);
    try {
      expect(opened.eventByKey(`msg.sent:${ID}`)?.actor).toEqual({
        nativeId: null,
        role: UNBOUND_MESSAGE_SENDER,
      });
      expect(opened.rebuild()).toMatchObject({ events: expect.any(Number) });
    } finally {
      opened.close();
    }
    expect(await recipient("inbox", "--include-body")).toMatchObject({
      code: EXIT_OK,
      json: {
        delivered: 1,
        messages: [
          {
            body: "Original.",
            decision: {
              display: "unknown",
              id: expect.stringMatching(/^q-msg-/),
              status: "pending",
            },
            from: UNBOUND_MESSAGE_SENDER,
            state: "delivered",
          },
        ],
      },
    });
    const decide = ["msg", "decide", ID, "--body-sha256", sha256("Original.")];
    expect(await recipient("msg", "done", ID)).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: message-decision-required\n",
    });
    expect(
      await recipient(...decide, "--approve", "--scope", "inspect logs", "--user-reply", "answer"),
    ).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: message-prompt-unattested\n",
    });
    expect(
      await recipient(
        "msg",
        "decide",
        ID,
        "--body-sha256",
        sha256("Different"),
        "--prompt",
        "prompt-1",
      ),
    ).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: message-body-mismatch\n",
    });
    expect(
      await cli(root, base, { CLAUDE_CODE_SESSION_ID: COORDINATOR })(
        ...decide,
        "--prompt",
        "prompt-1",
      ),
    ).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: not-recipient\n",
    });
    expect(await recipient(...decide, "--prompt", "prompt-1")).toMatchObject({
      code: EXIT_OK,
      json: {
        duplicate: false,
        message: { decision: { display: "attested", promptRef: "prompt-1", status: "pending" } },
      },
    });
    expect(await recipient(...decide, "--prompt", "different-prompt")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: message-prompt-conflict\n",
    });
    expect(await recipient("inbox")).toMatchObject({
      code: EXIT_OK,
      json: {
        delivered: 0,
        messages: [{ decision: { display: "attested", promptRef: "prompt-1", status: "pending" } }],
      },
    });
    const approval = [...decide, "--approve", "--scope", "inspect logs", "--user-reply", "reply-1"];
    expect(await recipient(...approval)).toMatchObject({
      code: EXIT_OK,
      json: {
        duplicate: false,
        message: { decision: { scope: "inspect logs", status: "approved", userReply: "reply-1" } },
      },
    });
    expect(await recipient(...approval)).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: true },
    });
    expect(await recipient(...decide, "--decline", "--user-reply", "reply-2")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: message-decision-conflict\n",
    });
    expect(await recipient("msg", "done", ID)).toMatchObject({
      code: EXIT_OK,
      json: { message: { decision: { status: "approved" }, state: "handled" } },
    });
    const status = await stranger("msg", "status", ID);
    expect(status.json).toMatchObject({ message: { decision: { status: "approved" } } });
    expect(status.out).not.toContain("inspect logs");
    expect(status.out).not.toContain("reply-1");
    const dispositions = join(
      storePath(layout),
      "roles",
      encodeURIComponent(recipientRole),
      "messages",
      "dispositions",
      ID,
    );
    expect(readdirSync(dispositions)).toHaveLength(5);
  });

  it("refuses an unidentified inbox, a non-recipient close, a secret body and an unknown recipient", async () => {
    const { base, root } = storeFixture();
    const coordinator = cli(root, base, { CLAUDE_CODE_SESSION_ID: COORDINATOR });
    expect(await cli(root, base, {})("inbox")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: caller-unidentified\n",
    });
    await coordinator("msg", "send", "--to", TECH_ROLE, "--body", "x", "--id", ID);
    expect(await coordinator("msg", "done", ID)).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: not-recipient\n",
    });
    writeFileSync(join(base, "key.txt"), ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "));
    expect(
      await cli(root, base, {})("msg", "send", "--to", TECH_ROLE, "--body-file", "key.txt"),
    ).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: secret-shaped-body\n",
    });
    expect(
      await cli(root, base, {})("msg", "send", "--to", "kits/unknown", "--body", "x"),
    ).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: recipient-unregistered\n",
    });
    expect(
      await coordinator("msg", "status", "00000000-0000-4000-8000-000000000999"),
    ).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: missing\n",
    });
  });

  it("reads an exact body only as its sender, recipient or coordinator without recording delivery", async () => {
    const { base, root } = storeFixture();
    const tech = cli(root, base, { CLAUDE_CODE_SESSION_ID: TECH });
    const art = cli(root, base, { CODEX_THREAD_ID: ART });
    const coordinator = cli(root, base, { CLAUDE_CODE_SESSION_ID: COORDINATOR });
    const gameplay = cli(root, base, { CLAUDE_CODE_SESSION_ID: GAMEPLAY });
    const reader = cli(root, base, {});
    const original = "Exact body.\n\n";
    expect((await tech("msg", "send", "--to", ART_ROLE, "--body", original, "--id", ID)).code).toBe(
      EXIT_OK,
    );
    for (const run of [tech, art, coordinator]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await run("msg", "status", ID, "--include-body")).toMatchObject({
        code: EXIT_OK,
        json: { message: { body: original, deliveredAt: null, id: ID, state: "sent" }, schema: 1 },
      });
    }
    expect(await gameplay("msg", "status", ID, "--include-body")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: message-not-visible\n",
      json: null,
    });
    expect(await reader("msg", "status", ID, "--include-body")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: caller-unidentified\n",
      json: null,
    });
    expect(await reader("msg", "status", ID, "--include-body", "--native-id", TECH)).toMatchObject({
      code: EXIT_OK,
      json: { message: { body: original } },
    });
    expect(await art("msg", "status", ID.slice(0, -1), "--include-body")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: missing\n",
      json: null,
    });
    expect((await reader("msg", "status", ID)).json?.message).not.toHaveProperty("body");
    expect((await reader("msg", "history")).json?.events).toEqual([
      expect.objectContaining({ kind: "msg.sent" }),
    ]);
  });

  it("defaults to the next scheduled review and accepts one explicit timed or dependency boundary", async () => {
    const { base, root } = storeFixture();
    const coordinator = cli(root, base, { CLAUDE_CODE_SESSION_ID: COORDINATOR });
    const tech = cli(root, base, { CLAUDE_CODE_SESSION_ID: TECH });
    await coordinator("msg", "send", "--to", TECH_ROLE, "--body", "Original.", "--id", ID);
    const retain = (...options: string[]) =>
      tech("msg", "retain", ID, "--reason", "Waiting", ...options);
    expect(await retain("--until", "2026-11-22T13:15-05:00")).toMatchObject({
      code: EXIT_OK,
      json: { message: { retention: { nextBoundary: "2026-11-22T18:15:00.000Z" } } },
    });
    expect(await retain("--until", "2026-11-22T18:15Z")).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: true },
    });
    expect(await retain()).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: false, message: { retention: { nextBoundary: "Next scheduled review" } } },
    });
    expect(await retain("--next-review")).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: true },
    });
    expect(await retain("--next-boundary", "  After the checked capture  ")).toMatchObject({
      code: EXIT_OK,
      json: { message: { retention: { nextBoundary: "  After the checked capture  " } } },
    });
    expect(await retain("--until", "2026-11-22T18:15")).toMatchObject({ code: EXIT_USAGE });
    expect(await retain("--until", "2026-09-31T18:15Z")).toMatchObject({ code: EXIT_USAGE });
    expect(await retain("--next-review", "--next-boundary", "Waiting")).toMatchObject({
      code: EXIT_USAGE,
    });
    expect(await retain("--next-review", "--until", "2026-11-22T18:15Z")).toMatchObject({
      code: EXIT_USAGE,
    });
  });

  it("requires an explicit retention boundary in a workspace without scheduled reviews", async () => {
    const { base, layout, root } = storeFixture();
    const config = JSON.parse(readFileSync(layout.configFile, "utf8")) as object;
    writeFileSync(layout.configFile, JSON.stringify({ ...config, wakeMinutes: [] }));
    const coordinator = cli(root, base, { CLAUDE_CODE_SESSION_ID: COORDINATOR });
    const tech = cli(root, base, { CLAUDE_CODE_SESSION_ID: TECH });
    await coordinator("msg", "send", "--to", TECH_ROLE, "--body", "Original.", "--id", ID);
    const retain = ["msg", "retain", ID, "--reason", "Waiting"];
    expect(await tech(...retain)).toMatchObject({ code: EXIT_USAGE });
    expect(await tech(...retain, "--next-boundary", "After owner review")).toMatchObject({
      code: EXIT_OK,
      json: { message: { retention: { nextBoundary: "After owner review" } } },
    });
  });

  it("keeps recipient retention evidence on exact metadata reads and replay", async () => {
    const { base, root } = storeFixture();
    const coordinator = cli(root, base, { CLAUDE_CODE_SESSION_ID: COORDINATOR });
    const tech = cli(root, base, { CLAUDE_CODE_SESSION_ID: TECH });
    const reader = cli(root, base, {});
    const retain = ["msg", "retain", ID, "--reason", "Deferred", "--next-review"];
    const refs = ["artifact:owner-disposition.json", "commit:abc"] as const;
    await coordinator("msg", "send", "--to", TECH_ROLE, "--body", "Original.", "--id", ID);

    expect(await coordinator(...retain, "--evidence", refs[0])).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: not-recipient\n",
    });
    expect(await tech(...retain)).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: false, message: { evidence: [], state: "retained" } },
    });
    expect(await tech(...retain, "--evidence", refs[0], "--evidence", refs[1])).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: false, message: { evidence: refs, state: "retained" } },
    });
    expect(
      await tech(...retain, "--evidence", refs[1], "--evidence", refs[0], "--evidence", refs[1]),
    ).toMatchObject({ code: EXIT_OK, json: { duplicate: true } });
    expect(await tech(...retain, "--evidence", "invalid reference")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: invalid-evidence\n",
    });
    expect(
      await tech("msg", "retain", ID, "--reason", "Still deferred", "--next-review"),
    ).toMatchObject({
      code: EXIT_OK,
      json: { duplicate: false, message: { evidence: refs, state: "retained" } },
    });
    expect(await tech("store", "rebuild")).toMatchObject({
      code: EXIT_OK,
      json: { verified: true },
    });
    const status = await reader("msg", "status", ID);
    expect(status).toMatchObject({
      code: EXIT_OK,
      json: { message: { evidence: refs, id: ID, state: "retained" } },
    });
    expect(status.json?.message).not.toHaveProperty("body");
  });

  it("rejects malformed options as usage errors", async () => {
    const { base, root } = storeFixture();
    const run = cli(root, base, { CLAUDE_CODE_SESSION_ID: COORDINATOR });
    for (const argv of [
      ["msg", "send", "--body", "x"],
      ["msg", "send", "--to", TECH_ROLE],
      ["msg", "send", "--to", TECH_ROLE, "--body", "x", "--body-file", "f"],
      ["msg", "send", "--to", TECH_ROLE, "--to", TECH_ROLE, "--body", "x"],
      ["msg", "send", "--to", TECH_ROLE, "--body", "x", "--link", "work"],
      ["msg", "send", "--to", TECH_ROLE, "--body", "x", "--intent", "later"],
      ["msg", "done"],
      ["msg", "done", ID, ID],
      ["msg", "retain", ID],
      ["msg", "status", ID, "--native-id", COORDINATOR],
      ["msg", "history", "--since", "yesterday"],
      ["msg", "history", "--limit", "0"],
      ["store", "import", "--dry-run"],
      ["store", "export"],
      ["inbox", "extra"],
      ["inbox", "--peek", "--include-body"],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await run(...argv)).code, argv.join(" ")).toBe(EXIT_USAGE);
    }
  });

  it("lists the store verbs in help with their positional IDs", async () => {
    const { base, root } = storeFixture();
    const help = await cli(root, base, {})("--help");
    expect(help.out).toContain(
      "msg done ID [--work WORK_ID] [--superseded-by ID] [--evidence REF ...]",
    );
    expect(help.out).toContain(
      "msg retain ID --reason TEXT --next-boundary TEXT [--owner ROLE] [--evidence REF ...]",
    );
    expect(help.out).toContain(
      "msg retain ID --reason TEXT --until ISO_TIMESTAMP [--owner ROLE] [--evidence REF ...]",
    );
    expect(help.out).toContain(
      "msg retain ID --reason TEXT [--next-review] [--owner ROLE] [--evidence REF ...]",
    );
    expect(help.out).toContain("msg status ID --include-body");
    expect(help.out).toContain(
      "msg send --to ROLE --body-file FILE [--intent queue|unblock] [--id UUID] [--link KIND=REF ...]",
    );
    expect(help.out).toContain("inbox [--include-body] [--all]");
    expect(help.out).toContain("inbox --peek");
    expect(help.out).toContain("store import --approval-ledger FILE [--dry-run]");
    expect(help.out).toContain("store retire [--dry-run]");
  });
});
