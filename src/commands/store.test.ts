import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, main } from "../cli.ts";
import { loadLayout } from "../layout.ts";
import { storePath } from "../store/db.ts";
import { ART, COORDINATOR, GAMEPLAY, storeFixture, TECH } from "../store/testStore.ts";

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

describe("store message commands", () => {
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

  it("refuses an unbound caller, a non-recipient close, a secret body and an unknown recipient", async () => {
    const { base, root } = storeFixture();
    const coordinator = cli(root, base, { CLAUDE_CODE_SESSION_ID: COORDINATOR });
    const stranger = cli(root, base, {
      CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-0000000000ff",
    });
    expect(await stranger("msg", "send", "--to", TECH_ROLE, "--body", "x")).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: caller-unbound\n",
    });
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
      await coordinator("msg", "send", "--to", TECH_ROLE, "--body-file", "key.txt"),
    ).toMatchObject({
      code: EXIT_INVALID,
      err: "coordination-kit: secret-shaped-body\n",
    });
    expect(await coordinator("msg", "send", "--to", "kits/unknown", "--body", "x")).toMatchObject({
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

  it("retains a message with one explicit timed, scheduled, or dependency boundary", async () => {
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
    expect(await retain("--next-review")).toMatchObject({
      code: EXIT_OK,
      json: { message: { retention: { nextBoundary: "Next scheduled review" } } },
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
      ["msg", "retain", ID, "--reason", "r"],
      ["msg", "status", ID, "--native-id", COORDINATOR],
      ["msg", "history", "--since", "yesterday"],
      ["msg", "history", "--limit", "0"],
      ["store", "import", "--dry-run"],
      ["store", "export"],
      ["inbox", "extra"],
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
    expect(help.out).toContain("msg retain ID --reason TEXT --next-boundary TEXT [--owner ROLE]");
    expect(help.out).toContain("msg retain ID --reason TEXT --until ISO_TIMESTAMP [--owner ROLE]");
    expect(help.out).toContain("msg retain ID --reason TEXT --next-review [--owner ROLE]");
    expect(help.out).toContain("msg status ID --include-body");
    expect(help.out).toContain(
      "msg send --to ROLE --body-file FILE [--intent queue|unblock] [--id UUID] [--link KIND=REF ...]",
    );
    expect(help.out).toContain("inbox [--include-body] [--all]");
    expect(help.out).toContain("store import --approval-ledger FILE [--dry-run]");
    expect(help.out).toContain("store retire --dry-run");
  });
});
