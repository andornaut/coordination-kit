import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readWakeFile, wakeFilePath } from "../adapters/claude/wakeFile.ts";
import { EXIT_OK, EXIT_USAGE, main } from "../cli.ts";
import type { Layout } from "../layout.ts";
import { MessageStore } from "../messages/store.ts";
import type { MessageOwner } from "../messages/types.ts";
import { protocolPaths, readStoreCutover } from "../protocol/layout.ts";
import { captureProtocolSelection } from "../protocol/selection.ts";
import { storeCutover } from "./cutover.ts";
import { Store, storePath } from "./db.ts";
import { messageStatus } from "./messages.ts";
import { storeMode } from "./mode.ts";
import { COORDINATOR, storeFixture, TECH } from "./testStore.ts";

const TECH_ROLE = "archies-dog-walks/tech";
const OWNER: MessageOwner = { harness: "claude", nativeId: TECH, parentBinding: null };
const LEGACY_ID = "00000000-0000-4000-8000-000000000401";
const NOW = () => "2026-11-18T20:40:00.000Z";

function legacyStore(layout: Layout): MessageStore {
  return new MessageStore({ layout, now: NOW, resolveOwner: () => OWNER });
}

function enqueue(layout: Layout, id: string) {
  return legacyStore(layout).enqueue({
    body: "Legacy body.\n",
    created: "2026-11-18T20:00:00.000Z",
    fromRole: "game-coordinator",
    id,
    intent: "queue",
    schema: 1,
    toRole: TECH_ROLE,
  });
}

/** An active work protocol at generation 1 with its state root beside the coordinator. */
function activateProtocol(base: string, layout: Layout): Record<string, unknown> {
  const stateRoot = join(base, "state");
  mkdirSync(stateRoot, { recursive: true });
  const config = { generation: 1, schema: 1, stateRoot, workspaceId: "ws-test" };
  writeFileSync(
    join(stateRoot, "workspace.json"),
    JSON.stringify({ generation: 1, schema: 1, workspaceId: "ws-test" }),
  );
  const paths = protocolPaths(layout);
  writeFileSync(paths.config, JSON.stringify(config));
  writeFileSync(paths.fence, JSON.stringify(config));
  return config;
}

const coordinator = { env: { CLAUDE_CODE_SESSION_ID: COORDINATOR } };

describe("store cutover", () => {
  it("prints the plan with counts on a dry run and writes nothing", async () => {
    const { layout } = storeFixture();
    await enqueue(layout, LEGACY_ID);
    const plan = await storeCutover({ env: {}, layout, now: NOW }, {}, { apply: false });
    expect(plan).toMatchObject({
      applied: false,
      cutoverAt: null,
      dryRun: true,
      fence: { generation: 1, management: "unmanaged", previousGeneration: 0 },
      import: { counts: { actions: { insert: 1 }, mapped: { sent: 1 } }, imported: 0 },
      importedUndelivered: 1,
      kind: "store-cutover",
      store: { exists: false },
    });
    expect(existsSync(storePath(layout))).toBe(false);
    expect(existsSync(protocolPaths(layout).fence)).toBe(false);
  });

  it("is the coordinator's alone", async () => {
    const { layout } = storeFixture();
    await expect(
      storeCutover({ env: { CLAUDE_CODE_SESSION_ID: TECH }, layout }, {}, { apply: true }),
    ).rejects.toMatchObject({ code: "not-coordinator" });
    await expect(storeCutover({ env: {}, layout }, {}, { apply: true })).rejects.toMatchObject({
      code: "caller-unidentified",
    });
    expect(existsSync(protocolPaths(layout).fence)).toBe(false);
  });

  it("fences legacy writers, imports, records the cutover and wakes, once", async () => {
    const { layout } = storeFixture();
    await enqueue(layout, LEGACY_ID);
    const applied = await storeCutover({ ...coordinator, layout, now: NOW }, {}, { apply: true });
    expect(applied).toMatchObject({
      applied: false,
      cutoverAt: "2026-11-18T20:40:00.000Z",
      dryRun: false,
      fence: { generation: 1, previousGeneration: 0 },
      import: { imported: 1 },
      wakes: [{ role: TECH_ROLE, status: "accepted" }],
    });
    expect(readStoreCutover(layout)).toEqual({
      cutoverAt: "2026-11-18T20:40:00.000Z",
      generation: 1,
      kind: "store-cutover",
      previous: null,
      schema: 1,
    });
    expect(storeMode(layout)).toEqual({ cutoverAt: "2026-11-18T20:40:00.000Z", mode: "store" });
    const store = Store.forLayout(layout);
    try {
      expect(messageStatus(store, LEGACY_ID)).toMatchObject({ state: "sent", to: TECH_ROLE });
      expect(store.eventByKey("store.cutover:2026-11-18T20:40:00.000Z")).toMatchObject({
        actor: { role: "game-coordinator" },
        payload: { cutoverAt: "2026-11-18T20:40:00.000Z", generation: 1, imported: 1 },
      });
    } finally {
      store.close();
    }
    expect(readWakeFile(wakeFilePath(layout, TECH))).toMatchObject({ count: 1, role: TECH_ROLE });
    // The generation fence refuses every later legacy write; legacy reads still work.
    await expect(enqueue(layout, "00000000-0000-4000-8000-000000000402")).rejects.toMatchObject({
      code: "store-cutover",
    });
    expect(legacyStore(layout).read(LEGACY_ID)).toMatchObject({ envelope: { id: LEGACY_ID } });
    expect(
      await storeCutover({ ...coordinator, layout, now: NOW }, {}, { apply: true }),
    ).toMatchObject({ applied: true, cutoverAt: "2026-11-18T20:40:00.000Z" });
  });

  it("bumps an active protocol's generation in the fence only, so a 1.3 reader fails closed", async () => {
    const { base, layout } = storeFixture();
    const config = activateProtocol(base, layout);
    const before = captureProtocolSelection(layout);
    await storeCutover({ ...coordinator, layout, now: NOW }, {}, { apply: true });
    const fence = JSON.parse(readFileSync(protocolPaths(layout).fence, "utf8")) as Record<
      string,
      unknown
    >;
    expect(fence).toMatchObject({ generation: 2, kind: "store-cutover", previous: config });
    // A 1.3 reader requires the fence to equal the configuration.
    expect(fence).not.toEqual(config);
    expect(captureProtocolSelection(layout)).toEqual(before);
    expect(storePath(layout)).toBe(join(base, "state", "coordination.db"));
    expect(storeMode(layout).mode).toBe("store");
  });

  it("switches back to legacy mode when the previous fence is restored", async () => {
    const { layout } = storeFixture();
    await storeCutover({ ...coordinator, layout, now: NOW }, {}, { apply: true });
    const { previous } = readStoreCutover(layout)!;
    expect(previous).toBeNull();
    // Unmanaged: the previous fence is no fence at all.
    rmSync(protocolPaths(layout).fence);
    expect(storeMode(layout).mode).toBe("legacy");
    await expect(enqueue(layout, LEGACY_ID)).resolves.toMatchObject({
      envelope: { id: LEGACY_ID },
    });
  });

  it("refuses a cutover fence without the store, and takes exactly one of --dry-run and --apply", async () => {
    const { base, layout, root } = storeFixture();
    await storeCutover({ ...coordinator, layout, now: NOW }, {}, { apply: true });
    rmSync(storePath(layout));
    expect(() => storeMode(layout)).toThrow(expect.objectContaining({ code: "store-missing" }));
    let err = "";
    const io = { cwd: base, env: {}, err: (text: string) => (err += text), out: () => {} };
    expect(await main(io, ["--root", root, "store", "cutover"])).toBe(EXIT_USAGE);
    expect(await main(io, ["--root", root, "store", "cutover", "--dry-run", "--apply"])).toBe(
      EXIT_USAGE,
    );
    const fresh = storeFixture();
    expect(await main(io, ["--root", fresh.root, "store", "cutover", "--dry-run"])).toBe(EXIT_OK);
    expect(err).toContain("invalid_store_options (store cutover)");
  });
});
