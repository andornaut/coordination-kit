import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EXIT_INVALID, EXIT_OK, EXIT_USAGE, main } from "../cli.ts";
import { readRegistry } from "../registry/store.ts";
import { Store } from "../store/db.ts";
import { checkpointPath } from "../store/sessionService.ts";
import { COORDINATOR, GAMEPLAY, storeFixture, TECH, TECH_CODEX } from "../store/testStore.ts";

const KIT = "art-kit";
const KIT_CLAUDE = "00000000-0000-4000-8000-0000000000c7";
const KIT_CODEX = "00000000-0000-4000-8000-0000000000d7";
const TECH_ROLE = "archies-dog-walks/tech";

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
      // Usage text is not JSON.
    }
    return { code, err, json, out };
  };
}

/** The store fixture plus a kit role with a conversation on each harness. */
function setup() {
  const fixture = storeFixture((roles) => {
    roles[KIT] = {
      conversations: { claude: KIT_CLAUDE, codex: KIT_CODEX },
      ownership: "active",
      worktree: "../art-kit/.worktrees/coordinator",
    };
  });
  const claude = (id: string) =>
    cli(fixture.root, fixture.base, { CLAUDE_CODE_SESSION_ID: id, PATH: process.env.PATH });
  const codex = (id: string) =>
    cli(fixture.root, fixture.base, { CODEX_THREAD_ID: id, PATH: process.env.PATH });
  const coordinator = claude(COORDINATOR);
  return {
    ...fixture,
    coordinator,
    gameplay: claude(GAMEPLAY),
    kit: claude(KIT_CLAUDE),
    kitTarget: codex(KIT_CODEX),
    reader: cli(fixture.root, fixture.base, { PATH: process.env.PATH }),
    stranger: claude("00000000-0000-4000-8000-0000000000e9"),
    tech: claude(TECH),
    techTarget: codex(TECH_CODEX),
    async select(...roles: string[]) {
      const revision = readRegistry(fixture.layout).revision;
      const scope = roles.flatMap((role) => ["--role", role]);
      const args = ["--harness", "codex", "--expected-revision", String(revision), ...scope];
      const result = await coordinator("harness", "select", ...args);
      expect(result.code, result.err).toBe(EXIT_OK);
    },
  };
}

describe("session start", () => {
  it("records the session and prints binding, checkpoint and counts, repeatably", async () => {
    const { coordinator, kit } = setup();
    await kit("hold", "set", "--id", "k-1", "--scope", "role", "--reason", "Paused");
    await kit("question", "open", "--title", "Ship it?");
    await coordinator("msg", "send", "--to", KIT, "--body", "Hello.");
    const first = await kit("session", "start");
    expect(first.code, first.err).toBe(EXIT_OK);
    expect(first.json).toMatchObject({
      checkpoint: "var/handoffs/kits/art-kit/current.md",
      conversation: KIT_CLAUDE,
      counts: { holds: 1, inbox: 1, questions: 1 },
      handoffs: [],
      harness: "claude",
      registry: { ownership: "active", phase: null },
      role: KIT,
      schema: 1,
      session: { version: expect.any(String) },
    });
    const second = await kit("session", "start");
    expect(second.code, second.err).toBe(EXIT_OK);
    expect((second.json!.session as { seq: number }).seq).toBeGreaterThan(
      (first.json!.session as { seq: number }).seq,
    );
  });

  it("writes the store under a stateRoot-only work-protocol.json", async () => {
    const { base, kit, layout } = setup();
    const state = join(base, "state");
    mkdirSync(state, { mode: 0o700 });
    writeFileSync(
      join(layout.varDir, "work-protocol.json"),
      JSON.stringify({ schema: 2, stateRoot: state }),
    );
    expect((await kit("session", "start")).code).toBe(EXIT_OK);
    expect(existsSync(join(state, "coordination.db"))).toBe(true);
  });

  it("derives the checkpoint for game, kit and coordinator roles", () => {
    expect(checkpointPath(TECH_ROLE)).toBe("var/handoffs/games/archies-dog-walks/tech/current.md");
    expect(checkpointPath(KIT)).toBe("var/handoffs/kits/art-kit/current.md");
    expect(checkpointPath("game-coordinator")).toBe("var/handoffs/game-coordinator/current.md");
  });

  it("refuses an unidentified, unbound or held caller", async () => {
    const { gameplay, reader, stranger } = setup();
    expect((await reader("session", "start")).err).toBe("coordination-kit: caller-unidentified\n");
    expect((await stranger("session", "start")).err).toBe("coordination-kit: caller-unbound\n");
    const held = await gameplay("session", "start");
    expect(held.code).toBe(EXIT_INVALID);
    expect(held.err).toBe("coordination-kit: session-held: phase held\n");
  });
});

describe("handoff", () => {
  it("runs open, ready, prepared, sent, select, active and completed", async () => {
    const { coordinator, kit, kitTarget, reader, select, tech, techTarget } = setup();
    const opened = await coordinator(
      "handoff",
      "open",
      "--scope",
      KIT,
      "--scope",
      TECH_ROLE,
      "--to",
      "codex",
    );
    expect(opened.code, opened.err).toBe(EXIT_OK);
    expect(opened.json).toMatchObject({
      duplicate: false,
      handoff: {
        from: "claude",
        id: "h-1",
        scope: [TECH_ROLE, KIT],
        state: "preparing",
        to: "codex",
      },
    });
    expect((await kit("handoff", "ready")).json).toMatchObject({ duplicate: false });
    expect((await kit("handoff", "ready")).json).toMatchObject({ duplicate: true });
    expect((await coordinator("handoff", "state", "prepared", "--id", "h-1")).err).toBe(
      "coordination-kit: handoff-not-ready\n",
    );
    await tech("handoff", "ready", "--id", "h-1");
    expect((await kit("session", "start")).json).toMatchObject({
      counts: { holds: 1 },
      handoffs: [{ id: "h-1", state: "preparing", to: "codex" }],
    });
    expect((await coordinator("handoff", "state", "prepared", "--id", "h-1")).code).toBe(EXIT_OK);
    expect((await coordinator("handoff", "state", "sent", "--id", "h-1")).code).toBe(EXIT_OK);
    // The target binding is not effective before select.
    expect((await kitTarget("handoff", "active")).err).toBe("coordination-kit: caller-unbound\n");
    expect((await kit("handoff", "active")).err).toBe("coordination-kit: not-target\n");
    await select(KIT, TECH_ROLE);
    // Select fences out the source sessions.
    expect((await kit("session", "start")).err).toBe("coordination-kit: caller-unbound\n");
    expect((await kitTarget("session", "start")).json).toMatchObject({
      conversation: KIT_CODEX,
      harness: "codex",
    });
    expect((await kitTarget("handoff", "active")).json).toMatchObject({ duplicate: false });
    expect((await coordinator("handoff", "state", "completed", "--id", "h-1")).err).toBe(
      "coordination-kit: handoff-not-active\n",
    );
    await techTarget("handoff", "active");
    const completed = await coordinator("handoff", "state", "completed", "--id", "h-1");
    expect(completed.json).toMatchObject({ handoff: { state: "completed" } });
    const shown = await reader("handoff", "show", "--id", "h-1");
    expect(shown.json).toMatchObject({
      handoff: {
        roles: [
          { activeAt: expect.any(String), readyAt: expect.any(String), role: TECH_ROLE },
          { activeAt: expect.any(String), readyAt: expect.any(String), role: KIT },
        ],
        state: "completed",
      },
      holds: [
        { id: "handoff-h-1-art-kit", role: KIT, state: "released" },
        { id: "handoff-h-1-archies-dog-walks-tech", role: TECH_ROLE, state: "released" },
      ],
    });
    expect((await reader("handoff", "show")).json).toMatchObject({ handoff: { id: "h-1" } });
  });

  it("refuses the wrong caller, conflicts and out-of-order states", async () => {
    const { coordinator, kit, reader, tech } = setup();
    expect((await kit("handoff", "open", "--scope", KIT, "--to", "codex")).err).toBe(
      "coordination-kit: not-coordinator\n",
    );
    expect((await coordinator("handoff", "open", "--scope", KIT, "--to", "claude")).err).toBe(
      "coordination-kit: already-on-target\n",
    );
    expect((await coordinator("handoff", "open", "--scope", "nobody", "--to", "codex")).err).toBe(
      "coordination-kit: role-unregistered\n",
    );
    expect((await coordinator("handoff", "open", "--to", "codex")).code).toBe(EXIT_USAGE);
    await coordinator("handoff", "open", "--scope", KIT, "--to", "codex");
    expect(
      (await coordinator("handoff", "open", "--scope", KIT, "--scope", TECH_ROLE, "--to", "codex"))
        .err,
    ).toBe("coordination-kit: handoff-conflict\n");
    expect((await tech("handoff", "ready")).err).toBe("coordination-kit: not-in-handoff\n");
    expect((await tech("handoff", "ready", "--id", "h-1")).err).toBe(
      "coordination-kit: not-in-handoff\n",
    );
    expect((await kit("handoff", "state", "prepared", "--id", "h-1")).err).toBe(
      "coordination-kit: not-coordinator\n",
    );
    expect((await coordinator("handoff", "state", "sent", "--id", "h-1")).err).toBe(
      "coordination-kit: invalid-transition\n",
    );
    expect((await coordinator("handoff", "state", "completed", "--id", "h-1")).err).toBe(
      "coordination-kit: invalid-transition\n",
    );
    expect((await coordinator("handoff", "state", "preparing", "--id", "h-1")).code).toBe(
      EXIT_USAGE,
    );
    expect((await reader("handoff", "show", "--id", "h-9")).err).toBe(
      "coordination-kit: handoff-missing\n",
    );
  });

  it("cancels from an open state and releases the handoff holds", async () => {
    const { coordinator, kit, reader, tech } = setup();
    await coordinator("handoff", "open", "--scope", "all", "--to", "codex", "--id", "kit-move");
    await kit("handoff", "ready");
    expect((await reader("hold", "list", "--state", "active")).json).toMatchObject({
      holds: [{ id: "handoff-kit-move-art-kit", role: KIT }],
    });
    const cancelled = await coordinator("handoff", "state", "cancelled", "--id", "kit-move");
    expect(cancelled.json).toMatchObject({ handoff: { state: "cancelled" }, released: [KIT] });
    expect((await reader("hold", "list", "--state", "active")).json).toMatchObject({ holds: [] });
    expect((await tech("handoff", "ready", "--id", "kit-move")).err).toBe(
      "coordination-kit: handoff-not-preparing\n",
    );
    expect((await coordinator("handoff", "state", "sent", "--id", "kit-move")).err).toBe(
      "coordination-kit: invalid-transition\n",
    );
    // A cancelled handoff no longer conflicts.
    expect((await coordinator("handoff", "open", "--scope", KIT, "--to", "codex")).code).toBe(
      EXIT_OK,
    );
  });

  it("withholds wakes while a role sits ready with its handoff hold", async () => {
    const { coordinator, kit } = setup();
    expect((await coordinator("msg", "send", "--to", KIT, "--body", "Before.")).json).toMatchObject(
      { wake: { status: "accepted" } },
    );
    await kit("inbox");
    await coordinator("handoff", "open", "--scope", KIT, "--to", "codex");
    await kit("handoff", "ready");
    expect((await coordinator("msg", "send", "--to", KIT, "--body", "During.")).json).toMatchObject(
      { wake: { status: "guarded" } },
    );
    const cancelled = await coordinator("handoff", "state", "cancelled", "--id", "h-1");
    expect(cancelled.json).toMatchObject({ released: [KIT] });
    await kit("inbox");
    expect((await coordinator("msg", "send", "--to", KIT, "--body", "After.")).json).toMatchObject({
      wake: { status: "accepted" },
    });
  });

  it("wakes the target through its handoff hold once harness select binds it", async () => {
    const { coordinator, kit, layout, select } = setup();
    await coordinator("handoff", "open", "--scope", KIT, "--to", "codex");
    await kit("handoff", "ready");
    await coordinator("handoff", "state", "prepared", "--id", "h-1");
    await coordinator("handoff", "state", "sent", "--id", "h-1");
    expect((await coordinator("msg", "send", "--to", KIT, "--body", "Source.")).json).toMatchObject(
      { wake: { status: "guarded" } },
    );
    await select(KIT);
    const target = await coordinator("msg", "send", "--to", KIT, "--body", "Run complete.");
    expect(target.code, target.err).toBe(EXIT_OK);
    // The store guard passes it: the wake is claimed for the Codex target (the fixture has no
    // control socket, so the native attempt itself does not succeed).
    const store = Store.forLayout(layout);
    try {
      const last = store.db
        .prepare("SELECT harness, conversation, detail FROM wakes WHERE role = ? ORDER BY seq DESC")
        .get(KIT) as { harness: string; conversation: string | null; detail: string | null };
      expect(last).toMatchObject({ conversation: KIT_CODEX, harness: "codex" });
      expect(last.detail).not.toBe("recipient-hold-active");
    } finally {
      store.close();
    }
  });
});
