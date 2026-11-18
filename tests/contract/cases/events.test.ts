// Bus event outbox deduplication and flush ordering through the built recordEvent and
// flushEvents, delivered to a Codex recipient on the fake control socket.
import { afterEach, expect } from "vitest";

import { contract, suite, workspaces } from "../lib/cases.ts";
import { eventId, flush, record, sent } from "../lib/event-passes.ts";
import { otherGame } from "../lib/routes.ts";
import { TECH } from "../lib/unblock-native.ts";
import { Reviewed } from "../lib/unblock-review.ts";
import type { Workspace } from "../lib/workspace.ts";

const KEY = "fixture-attempt";

suite("events", () => {
  const workspace = workspaces();
  const open: Reviewed[] = [];
  afterEach(async () => {
    for (const reviewed of open.splice(0)) await reviewed.close();
  });

  /** A Codex game whose events go to the cleared game-coordinator recipient. */
  async function reporter(ws: Workspace): Promise<Reviewed> {
    const m = await Reviewed.routed(ws, { host: otherGame(ws) });
    open.push(m);
    ws.config.reports = { project: "Fixture", recipient: "game-coordinator" };
    return m;
  }

  function inputs(m: Reviewed): string[] {
    return m.world
      .mutations()
      .map((call) => (call.params.input as Array<{ text: string }>)[0]!.text);
  }

  contract("blocked events for one attempt deduplicate across stages", async () => {
    const ws = workspace();
    const m = await reporter(ws);
    // Each stage records from its own process; every blocked-* kind shares one identity.
    await record(ws, { kind: "blocked-full-gate", key: KEY, message: "full gate failed" });
    await record(ws, { kind: "blocked-ci", key: KEY, message: "CI failed" });
    await record(ws, { kind: "blocked-full-gate", key: KEY, message: "full gate failed again" });
    const blocked = ws.events();
    expect(blocked.map((event) => [event.id, event.kind, event.message])).toEqual([
      [eventId("blocked-ci", KEY), "blocked-full-gate", "Fixture bus: full gate failed"],
    ]);
    await flush(ws, 2);
    expect(sent(ws, String(blocked[0]!.id))).toBe(true);
    expect(inputs(m)).toEqual([
      `Fixture bus: full gate failed [bus event ${eventId("blocked-ci", KEY).slice(0, 12)}]`,
    ]);
  });

  contract("a flush delivers in creation order and the first refusal holds the rest", async () => {
    const ws = workspace();
    const m = await reporter(ws);
    const kinds = ["attempt", "push", "deployed"];
    await record(ws, ...kinds.map((kind) => ({ kind, key: KEY, message: kind })));
    const ids = kinds.map((kind) => eventId(kind, KEY));
    expect(ws.events().map((event) => event.id)).toEqual(ids);
    // The first is accepted; the second has an unknown outcome.
    m.world.outcomes.push({ result: { turnId: "turn-one" } }, { close: true });
    await flush(ws, 3);
    expect(inputs(m).map((text) => text.split(" [")[0])).toEqual([
      "Fixture bus: attempt",
      "Fixture bus: push",
    ]);
    expect(ids.map((id) => sent(ws, id))).toEqual([true, false, false]);
    expect(ws.readJson(`events/native/${ids[1]}-${TECH}.json`).status).toBe("ambiguous");
    expect(ws.list("events", "native")).toEqual(
      ids
        .slice(0, 2)
        .map((id) => `${id}-${TECH}.json`)
        .sort(),
    );
  });
});
