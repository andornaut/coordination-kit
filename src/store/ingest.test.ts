import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../cli.ts";
import { EXIT_OK, EXIT_USAGE } from "../core/io.ts";
import { type GameLayout, gameLayout, type Layout } from "../core/layout.ts";
import { clockAt, TEST_CONTEXT } from "../core/testFixtures.ts";
import { Store } from "./db.ts";
import {
  busEventId,
  CURSOR_FILE,
  type IngestContext,
  ingestEvents,
  LOG_FILE,
  QUARANTINE_FILE,
  readCursor,
} from "./ingest.ts";
import { derivedId } from "./notices.ts";
import { GAME, storeFixture } from "./testStore.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA2 = "89abcdef0123456789abcdef0123456789abcdef";
const AT = "2026-11-18T15:00:00Z";

afterEach(() => {
  vi.restoreAllMocks();
});

type Line = Record<string, unknown>;

function line(
  type: string,
  key: string,
  kind: string,
  status: string | null,
  extra: Partial<Line> = {},
): Line {
  return {
    schema: 1,
    id: busEventId(GAME, type, key),
    game: GAME,
    kind,
    type,
    key,
    at: AT,
    sha: null,
    status,
    detail: null,
    work: null,
    ...extra,
  };
}

function text(...lines: Line[]): string {
  return lines.map((value) => `${JSON.stringify(value)}\n`).join("");
}

/** The four passing events for one commit, with the deploy event given. */
function shipped(sha: string, deploy: Line): Line[] {
  return [
    line("gate_passed", sha, "gate", "ok", { sha }),
    line("push", sha, "push", "ok", { sha }),
    line("ci_success", sha, "ci", "ok", { sha }),
    deploy,
  ];
}

interface Setup {
  readonly layout: Layout;
  readonly game: GameLayout;
  readonly log: string;
  readonly context: IngestContext;
}

function setup(): Setup {
  const { layout } = storeFixture();
  const game = gameLayout(layout, GAME);
  mkdirSync(game.busDir, { recursive: true });
  return {
    context: { clock: clockAt("2026-11-18T16:00:00.000Z"), env: {}, layout },
    game,
    layout,
    log: join(game.busDir, LOG_FILE),
  };
}

function withStore<T>(layout: Layout, body: (store: Store) => T): T {
  const store = Store.forLayout(TEST_CONTEXT, layout);
  try {
    return body(store);
  } finally {
    store.close();
  }
}

function busEvents(layout: Layout): string[] {
  return withStore(layout, (store) =>
    (store.db.prepare("SELECT type FROM bus_events ORDER BY seq").all() as { type: string }[]).map(
      (row) => row.type,
    ),
  );
}

interface StoredMessage {
  id: string;
  from_role: string;
  to_role: string;
  body: string;
  links: string;
}

function messages(layout: Layout): StoredMessage[] {
  return withStore(
    layout,
    (store) =>
      store.db
        .prepare("SELECT id, from_role, to_role, body, links FROM messages ORDER BY sent_seq")
        .all() as unknown as StoredMessage[],
  );
}

function completes(layout: Layout): StoredMessage[] {
  return messages(layout).filter((message) => message.body.includes("COMPLETE"));
}

describe("events ingest", () => {
  it("commits each line once, then writes the cursor, and a repeated ingest is a no-op", async () => {
    const test = setup();
    const first = line("runner.started", "start1", "runner", null);
    const second = line("blocked-gate", "a1", "gate", "blocked", { detail: "lint failed" });
    writeFileSync(test.log, text(first, second));
    const result = await ingestEvents(test.context, test.game);
    expect(result).toMatchObject({
      completed: 0,
      delivered: 2,
      held: 0,
      ingested: 2,
      quarantined: 0,
      reason: null,
      status: "delivered",
    });
    const stat = statSync(test.log);
    expect(readCursor(test.game.busDir)).toEqual({
      at: "2026-11-18T16:00:00.000Z",
      dev: Number(stat.dev),
      file: LOG_FILE,
      firstId: first.id,
      inode: Number(stat.ino),
      lastId: second.id,
      lines: 2,
      offset: stat.size,
      schema: 1,
    });
    expect(busEvents(test.layout)).toEqual(["runner.started", "blocked-gate"]);
    expect(messages(test.layout)).toEqual([
      expect.objectContaining({
        body: "Archie bus: runner.started",
        from_role: "delivery-kit",
        id: derivedId("bus-event", first.id as string),
        to_role: "game-coordinator",
      }),
      expect.objectContaining({ body: "Archie bus: blocked-gate blocked: lint failed" }),
    ]);
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      delivered: 0,
      ingested: 0,
      reason: "no-events",
      status: "skipped",
    });
    expect(messages(test.layout)).toHaveLength(2);
  });

  it("writes no cursor when the commit fails; re-ingest after a lost cursor stores nothing twice", async () => {
    const test = setup();
    writeFileSync(test.log, text(line("pin-mismatch", "a1", "runner", null)));
    const spy = vi.spyOn(Store.prototype, "transaction").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    await expect(ingestEvents(test.context, test.game)).rejects.toThrow("disk full");
    expect(existsSync(join(test.game.busDir, CURSOR_FILE))).toBe(false);
    spy.mockRestore();
    expect((await ingestEvents(test.context, test.game)).delivered).toBe(1);
    // A crash after the commit and before the cursor: the unique key absorbs the replay.
    renameSync(join(test.game.busDir, CURSOR_FILE), join(test.game.busDir, "lost"));
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      delivered: 0,
      ingested: 1,
      status: "skipped",
    });
    expect(messages(test.layout)).toHaveLength(1);
  });

  it("never consumes an unterminated last line and takes it once the runner terminates it", async () => {
    const test = setup();
    const done = line("attempt_started", "a1", "attempt", "ok");
    const torn = JSON.stringify(line("attempt_started", "a2", "attempt", "ok"));
    writeFileSync(test.log, `${text(done)}${torn.slice(0, 20)}`);
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      delivered: 1,
      held: 1,
      status: "delivered",
    });
    expect(readCursor(test.game.busDir)?.offset).toBe(text(done).length);
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      delivered: 0,
      held: 1,
      reason: "in-flight",
      status: "deferred",
    });
    appendFileSync(test.log, `${torn.slice(20)}\n`);
    expect(await ingestEvents(test.context, test.game)).toMatchObject({ delivered: 1, held: 0 });
    expect(busEvents(test.layout)).toEqual(["attempt_started", "attempt_started"]);
  });

  it("stores lines whose status is null, as the line schema allows", async () => {
    const test = setup();
    const started = line("runner.started", "t1", "runner", null, { detail: "{}" });
    const attempt = line("attempt", "a1", "attempt", null);
    writeFileSync(test.log, text(started, attempt));
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      ingested: 2,
      quarantined: 0,
    });
    expect(busEvents(test.layout).sort()).toEqual(["attempt", "runner.started"]);
  });

  it("copies each complete malformed line to the quarantine and skips it", async () => {
    const test = setup();
    const forged = { ...line("pushed", SHA, "push", "ok", { sha: SHA }), id: "f".repeat(64) };
    const good = line("attempt_started", "a1", "attempt", "ok");
    writeFileSync(test.log, `{"schema":1,"torn\n${JSON.stringify(forged)}\n${text(good)}`);
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      delivered: 1,
      ingested: 3,
      quarantined: 2,
    });
    expect(readFileSync(join(test.game.busDir, QUARANTINE_FILE), "utf8")).toBe(
      `{"schema":1,"torn\n${JSON.stringify(forged)}\n`,
    );
    expect(busEvents(test.layout)).toEqual(["attempt_started"]);
    // Resumed by inode: the malformed first line is not quarantined again.
    appendFileSync(test.log, text(line("attempt_started", "a2", "attempt", "ok")));
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      delivered: 1,
      quarantined: 0,
    });
  });

  it("finishes a rotated file from the cursor, then the live file, then deletes the rotated file", async () => {
    const test = setup();
    const a = line("attempt_started", "a1", "attempt", "ok");
    writeFileSync(test.log, text(a));
    await ingestEvents(test.context, test.game);
    const b = line("attempt_started", "a2", "attempt", "ok");
    appendFileSync(test.log, text(b));
    const rotated = join(test.game.busDir, "events.1763478000.jsonl");
    renameSync(test.log, rotated);
    const c = line("attempt_started", "a3", "attempt", "ok");
    writeFileSync(test.log, text(c));
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      delivered: 2,
      ingested: 2,
    });
    expect(existsSync(rotated)).toBe(false);
    expect(readCursor(test.game.busDir)).toMatchObject({ firstId: c.id, lastId: c.id, lines: 1 });
    expect(withStore(test.layout, (store) => store.events({ kinds: ["bus.event"] }).length)).toBe(
      3,
    );
  });

  it("sees a rotation between opening the live file and listing rotations exactly once", async () => {
    const test = setup();
    const a = line("attempt_started", "a1", "attempt", "ok");
    writeFileSync(test.log, text(a));
    await ingestEvents(test.context, test.game);
    const b = line("attempt_started", "a2", "attempt", "ok");
    appendFileSync(test.log, text(b));
    const rotated = join(test.game.busDir, "events.1763478000.jsonl");
    const c = line("attempt_started", "a3", "attempt", "ok");
    const rotate = () => {
      renameSync(test.log, rotated);
      writeFileSync(test.log, text(c));
    };
    expect(await ingestEvents({ ...test.context, afterOpenLive: rotate }, test.game)).toMatchObject(
      { delivered: 1, ingested: 1 },
    );
    // The open descriptor was the rotated file: it stays until the cursor passes it.
    expect(existsSync(rotated)).toBe(true);
    expect(readCursor(test.game.busDir)?.firstId).toBe(a.id);
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      delivered: 1,
      ingested: 1,
    });
    expect(existsSync(rotated)).toBe(false);
    expect(readdirSync(test.game.busDir).filter((name) => name.endsWith(".jsonl"))).toEqual([
      LOG_FILE,
    ]);
    expect(withStore(test.layout, (store) => store.events({ kinds: ["bus.event"] }).length)).toBe(
      3,
    );
  });

  it("matches a file without a first id only by inode and dev, else reads from 0", async () => {
    const test = setup();
    writeFileSync(test.log, `not json\n${text(line("attempt_started", "a1", "attempt", "ok"))}`);
    await ingestEvents(test.context, test.game);
    expect(readCursor(test.game.busDir)?.firstId).toBeNull();
    // A new live file, also without a first id: a different inode, so no match and a read from 0.
    const replacement = join(test.game.busDir, "replacement");
    writeFileSync(
      replacement,
      `still not json\n${text(
        line("attempt_started", "a1", "attempt", "ok"),
        line("attempt_started", "a2", "attempt", "ok"),
      )}`,
    );
    renameSync(replacement, test.log);
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      delivered: 1,
      ingested: 3,
      quarantined: 1,
    });
  });

  it("derives COMPLETE once per commit with its work IDs for ok, skipped and disabled deploys", async () => {
    const test = setup();
    const third = "fedcba9876543210fedcba9876543210fedcba98";
    writeFileSync(
      test.log,
      text(
        ...shipped(
          SHA,
          line("deploy_success", SHA, "deploy", "ok", { sha: SHA, work: ["ck-0001"] }),
        ),
        ...shipped(
          SHA2,
          line("deploy_skipped", SHA2, "deploy", "skipped", { sha: SHA2, work: ["ck-0002"] }),
        ),
        ...shipped(
          third,
          line("deploy_disabled", third, "deploy", "skipped", { sha: third, work: [] }),
        ),
      ),
    );
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      completed: 3,
      // delivered counts committed lines; quiet gate_passed lines are stored but not messages.
      delivered: 12,
    });
    expect(messages(test.layout).filter((message) => message.body.includes("gate_passed"))).toEqual(
      [],
    );
    const stored = completes(test.layout);
    expect(stored.map((message) => message.id)).toEqual([
      derivedId("complete", GAME, SHA),
      derivedId("complete", GAME, SHA2),
      derivedId("complete", GAME, third),
    ]);
    expect(stored[0]).toMatchObject({
      body: `Archie bus: COMPLETE ${SHA}: gate ok, push ok, ci ok, deploy deploy_success (ok); work: ck-0001`,
      from_role: "delivery-kit",
      to_role: "game-coordinator",
    });
    expect(JSON.parse(stored[0]!.links)).toEqual([
      { kind: "commit", ref: SHA },
      { kind: "work", ref: "ck-0001" },
    ]);
    expect(stored[1]!.body).toContain("deploy deploy_skipped (skipped); work: ck-0002");
    expect(stored[2]!.body).toContain("deploy deploy_disabled (skipped); work: none");
    renameSync(join(test.game.busDir, CURSOR_FILE), join(test.game.busDir, "lost"));
    expect((await ingestEvents(test.context, test.game)).completed).toBe(0);
    expect(completes(test.layout)).toHaveLength(3);
  });

  it("stores no COMPLETE when CI failed, and a progress type is not success", async () => {
    const test = setup();
    writeFileSync(
      test.log,
      text(
        line("gate_passed", SHA, "gate", "ok", { sha: SHA }),
        line("pushed", SHA, "push", "ok", { sha: SHA }),
        line("ci_pending", SHA, "ci", "ok", { sha: SHA }),
        line("ci_failure", SHA, "ci", "failed", { sha: SHA }),
        line("deploy_disabled", SHA, "deploy", "skipped", { sha: SHA, work: [] }),
      ),
    );
    expect((await ingestEvents(test.context, test.game)).completed).toBe(0);
    expect(completes(test.layout)).toEqual([]);
  });

  it("records each work ID once per game: the first COMPLETE that lists it keeps it", async () => {
    const test = setup();
    writeFileSync(
      test.log,
      text(
        ...shipped(
          SHA,
          line("deploy_success", SHA, "deploy", "ok", { sha: SHA, work: ["ck-0001"] }),
        ),
        ...shipped(
          SHA2,
          line("deploy_success", SHA2, "deploy", "ok", { sha: SHA2, work: ["ck-0001", "ck-0002"] }),
        ),
      ),
    );
    await ingestEvents(test.context, test.game);
    const [first, second] = completes(test.layout);
    expect(first!.body).toMatch(/work: ck-0001$/);
    expect(second!.body).toMatch(/work: ck-0002$/);
    expect(
      withStore(test.layout, (store) =>
        store.db.prepare("SELECT work, sha FROM bus_work ORDER BY work").all(),
      ),
    ).toEqual([
      { sha: SHA, work: "ck-0001" },
      { sha: SHA2, work: "ck-0002" },
    ]);
  });

  it("stores quiet types as events without messages, and gate_skipped still counts toward COMPLETE", async () => {
    const test = setup();
    writeFileSync(
      test.log,
      text(
        line("gate_skipped", SHA, "gate", "skipped", { detail: "docs only", sha: SHA }),
        line("pushed", SHA, "push", "ok", { detail: "imported at 6.1 start", sha: SHA }),
        line("ci_pending", SHA, "ci", "ok", { sha: SHA }),
        line("ci_success", SHA, "ci", "ok", { sha: SHA }),
        line("deploy_retry", SHA, "deploy", null, { sha: SHA }),
        line("deploy_success", SHA, "deploy", "ok", { sha: SHA, work: [] }),
      ),
    );
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      completed: 1,
      delivered: 6,
    });
    expect(busEvents(test.layout)).toEqual([
      "gate_skipped",
      "pushed",
      "ci_pending",
      "ci_success",
      "deploy_retry",
      "deploy_success",
    ]);
    const bodies = messages(test.layout).map((message) => message.body);
    expect(bodies).toEqual([
      `Archie bus: COMPLETE ${SHA}: gate skipped, push ok, ci ok, deploy deploy_success (ok); work: none`,
    ]);
  });

  it.each([
    ["gate snapshot", "gate_passed", "ok", "deploy_success", "ok"],
    ["docs-only pinned push", "gate_skipped", "skipped", "deploy_skipped", "skipped"],
  ])(
    "records the %s capture and sends one COMPLETE after the passing outcomes",
    async (captureSource, gateType, gateStatus, deployType, deployStatus) => {
      const test = setup();
      const key = "1795014000";
      const scheduled = line("scheduled-status", key, "runner", null);
      const attempt = line("attempt", key, "attempt", null);
      const capture = line("attempt-captured", key, "attempt", null, {
        detail: `captured ${captureSource}`,
        sha: SHA,
      });
      const gate = line(gateType, SHA, "gate", gateStatus, { sha: SHA });
      const push = line("push", SHA, "push", "ok", { sha: SHA });
      writeFileSync(test.log, text(scheduled, attempt, capture, gate, push));
      expect(await ingestEvents(test.context, test.game)).toMatchObject({
        completed: 0,
        delivered: 5,
        quarantined: 0,
      });
      expect(messages(test.layout)).toEqual([]);
      const ci = line("ci_success", SHA, "ci", "ok", { sha: SHA });
      const deploy = line(deployType, SHA, "deploy", deployStatus, { sha: SHA, work: [] });
      appendFileSync(test.log, text(ci, deploy));
      expect(await ingestEvents(test.context, test.game)).toMatchObject({
        completed: 1,
        delivered: 2,
      });
      expect(messages(test.layout).map((message) => message.id)).toEqual([
        derivedId("complete", GAME, SHA),
      ]);
      expect(
        withStore(test.layout, (store) =>
          store.events({ kinds: ["bus.event"] }).map((event) => event.payload),
        ),
      ).toEqual([scheduled, attempt, capture, gate, push, ci, deploy]);
      expect((await ingestEvents(test.context, test.game)).completed).toBe(0);
      expect(messages(test.layout)).toHaveLength(1);
    },
  );

  it("stores actionable failures immediately without waiting for a COMPLETE", async () => {
    const test = setup();
    const blocked = line("blocked-load", "1795014000", "attempt", "blocked");
    const failed = line("blocked-full-gate", "1795017600", "gate", "failed");
    const ci = line("ci_timeout", SHA, "ci", "timeout", { sha: SHA });
    const deploy = line("deploy_failure", SHA, "deploy", "failed", { sha: SHA });
    writeFileSync(
      test.log,
      text(
        blocked,
        failed,
        line("gate_passed", SHA, "gate", "ok", { sha: SHA }),
        line("push", SHA, "push", "ok", { sha: SHA }),
      ),
    );
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      completed: 0,
      delivered: 4,
    });
    expect(messages(test.layout)).toHaveLength(2);
    appendFileSync(test.log, text(ci, deploy));
    expect(await ingestEvents(test.context, test.game)).toMatchObject({
      completed: 0,
      delivered: 2,
    });
    expect(messages(test.layout).map((message) => message.id)).toEqual(
      [blocked, failed, ci, deploy].map((event) => derivedId("bus-event", event.id as string)),
    );
  });

  it("keeps blocked events apart per type", async () => {
    const test = setup();
    writeFileSync(
      test.log,
      text(
        line("blocked-gate", "a1", "gate", "blocked"),
        line("blocked-full-gate", "a1", "gate", "blocked"),
      ),
    );
    expect((await ingestEvents(test.context, test.game)).delivered).toBe(2);
    expect(messages(test.layout)).toHaveLength(2);
  });

  it("treats an imported legacy complete line as the COMPLETE, deduplicated with the derived one", async () => {
    const test = setup();
    writeFileSync(
      test.log,
      text(
        line("complete", SHA, "runner", "ok", { detail: "shipped", sha: SHA, work: ["ck-0003"] }),
        ...shipped(SHA, line("deploy_success", SHA, "deploy", "ok", { sha: SHA, work: [] })),
      ),
    );
    expect((await ingestEvents(test.context, test.game)).completed).toBe(1);
    const stored = completes(test.layout);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.body).toBe(`Archie bus: COMPLETE ${SHA}; shipped; work: ck-0003`);
    expect(messages(test.layout).some((message) => message.body.includes("complete ok"))).toBe(
      false,
    );
  });

  it("stores no COMPLETE message when an imported legacy message already delivered it", async () => {
    const test = setup();
    withStore(test.layout, (store) =>
      store.append({
        actor: { nativeId: null, role: null },
        key: "msg.imported:legacy-complete-1",
        kind: "msg.imported",
        payload: {
          body: `Archie bus: COMPLETE ${SHA} deployed`,
          bodySha256: "0".repeat(64),
          closedAt: null,
          createdAt: AT,
          deliveredAt: AT,
          evidence: [],
          from: "delivery-kit",
          id: "legacy-complete-1",
          intent: "queue",
          legacy: { payloadHash: "0".repeat(64), source: "state-root", state: "accepted" },
          links: [],
          retention: null,
          state: "delivered",
          supersededBy: null,
          to: "game-coordinator",
          unconfirmed: false,
          work: null,
        },
      }),
    );
    writeFileSync(
      test.log,
      text(...shipped(SHA, line("deploy_success", SHA, "deploy", "ok", { sha: SHA, work: [] }))),
    );
    expect((await ingestEvents(test.context, test.game)).completed).toBe(0);
    expect(completes(test.layout).map((message) => message.id)).toEqual(["legacy-complete-1"]);
    expect(
      withStore(test.layout, (store) =>
        store.db.prepare("SELECT source, message_id FROM bus_completes").all(),
      ),
    ).toEqual([{ message_id: "legacy-complete-1", source: "legacy-message" }]);
  });

  it("prints the typed events-ingest envelope with non-negative integer counts", async () => {
    const test = setup();
    writeFileSync(test.log, text(line("attempt_started", "a1", "attempt", "ok")));
    let out = "";
    let err = "";
    const io = {
      cwd: test.layout.root,
      env: {},
      err: (value: string) => (err += value),
      out: (value: string) => (out += value),
    };
    expect(await main(io, ["--root", test.layout.root, "events", "ingest", "--game", GAME])).toBe(
      EXIT_OK,
    );
    const result = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual([
      "schema",
      "kind",
      "game",
      "status",
      "reason",
      "detail",
      "delivered",
      "held",
      "ingested",
      "quarantined",
      "completed",
      "cli",
    ]);
    expect(result).toMatchObject({
      game: GAME,
      kind: "events-ingest",
      schema: 1,
      status: "delivered",
    });
    for (const key of ["delivered", "held", "ingested", "quarantined", "completed"]) {
      expect(Number.isSafeInteger(result[key]) && (result[key] as number) >= 0).toBe(true);
    }
    expect(await main(io, ["--root", test.layout.root, "events", "ingest"])).toBe(EXIT_USAGE);
    expect(err).toContain("--game is required");
  });
});
