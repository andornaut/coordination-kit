import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appLayout, loadLayout } from "../../core/configuration/layout.ts";
import {
  coordinatorConfig,
  stateRootFixture,
  TEST_CONTEXT,
  TEST_GIT,
  writeFixtureJson,
} from "../../core/testFixtures.ts";
import { readRegistry } from "../../registry/store.ts";
import { legacyStorePath, Store } from "../db.ts";
import { recordSession } from "../sessions/handoffs.ts";
import { COORDINATOR, GAME, storeFixture } from "../testStore.ts";
import { GENESIS } from "../types.ts";
import { type CutoverReceipt, fileAuthority } from "./authority.ts";

function fixture(mode: "legacy" | "workspace" | "standalone" = "legacy") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-authority-")));
  TEST_GIT(root, ["init", "-q", "--initial-branch=main"]);
  const name = mode === "legacy" ? "var" : ".coordination-kit";
  writeFileSync(join(root, ".gitignore"), `/${name}/\n`);
  if (mode === "standalone") {
    writeFixtureJson(join(root, "coordination-kit.json"), {
      project: { id: "fixture", roles: ["maintainer"] },
      review: "off",
      schema: 1,
    });
  } else {
    const configFile = mode === "legacy" ? "config.json" : "coordination-kit.json";
    writeFixtureJson(join(root, configFile), coordinatorConfig());
  }
  const layout = loadLayout(root);
  const legacyPath = join(layout.varDir, "coordination.db");
  const marker = join(layout.varDir, "coordination-authority.json");
  const path = join(layout.varDir, "coordination");
  const witness = join(path, "source-fence.json");
  const authority = (create = false) => fileAuthority(TEST_GIT, layout, legacyPath, { create });
  return { authority, layout, legacyPath, marker, path, root, witness };
}

const PREPARED = {
  head: { hash: "a".repeat(64), seq: 42 },
  id: "00000000-0000-4000-8000-000000000001",
  phase: "prepared",
  proof: "b".repeat(64),
  schema: 1,
} as const satisfies Omit<CutoverReceipt, "legacyPath" | "root">;

function activatedFixture() {
  const fx = fixture();
  const prepared = { ...PREPARED, legacyPath: fx.legacyPath, root: fx.root } as const;
  const active = { ...prepared, phase: "active" } as const;
  mkdirSync(fx.path, { recursive: true });
  writeFixtureJson(fx.marker, active);
  writeFixtureJson(fx.witness, prepared);
  return { ...fx, active, prepared };
}

describe("file authority bootstrap", () => {
  it.each(["legacy", "workspace", "standalone"] as const)(
    "creates only on write in %s mode",
    (mode) => {
      const { authority, layout, legacyPath, marker, path, root, witness } = fixture(mode);
      expect(authority()).toBeNull();
      expect(existsSync(layout.varDir)).toBe(false);

      const initialized = authority(true);
      expect(initialized).toMatchObject({
        kind: "files",
        path,
        receipt: { head: { hash: GENESIS, seq: 0 }, legacyPath, phase: "active", root, schema: 1 },
      });
      expect(authority()).toEqual(initialized);
      expect(authority(true)).toEqual(initialized);
      expect(existsSync(legacyPath)).toBe(false);
      expect(readdirSync(path)).toEqual(["source-fence.json"]);
      expect(JSON.parse(readFileSync(witness, "utf8"))).toEqual({
        ...initialized?.receipt,
        phase: "prepared",
      });
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(initialized?.receipt);
    },
  );

  it("resumes first publication using the identical genesis witness", () => {
    const { authority, marker } = fixture();
    const initialized = authority(true);
    unlinkSync(marker);
    expect(authority()).toBeNull();
    expect(existsSync(marker)).toBe(false);
    expect(authority(true)).toEqual(initialized);
  });

  it("blocks legacy DB files or sidecars before creating a fresh authority", () => {
    const { authority, layout, legacyPath, marker, path } = fixture();
    mkdirSync(layout.varDir);
    for (const name of [legacyPath, `${legacyPath}-wal`]) {
      writeFileSync(name, "Bytes of a legacy source");
      expect(() => authority()).toThrow("file-authority-legacy-state");
      expect(() => authority(true)).toThrow("file-authority-legacy-state");
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(path)).toBe(false);
      expect(readFileSync(name, "utf8")).toBe("Bytes of a legacy source");
      unlinkSync(name);
    }
  });

  it("blocks an unqualified former local database before creating canonical workspace state", () => {
    const { authority, layout, root } = fixture("workspace");
    mkdirSync(join(root, "var"));
    writeFileSync(join(root, "var", "coordination.db-wal"), "Legacy source sidecar");
    expect(() => authority()).toThrow("file-authority-legacy-state");
    expect(() => authority(true)).toThrow("file-authority-legacy-state");
    expect(existsSync(layout.varDir)).toBe(false);
  });

  it("refuses an unignored or redirected state path", () => {
    const { authority, layout, root } = fixture();
    writeFileSync(join(root, ".gitignore"), "");
    expect(() => authority(true)).toThrow("file-authority-non-primary-checkout");
    expect(existsSync(layout.varDir)).toBe(false);
    symlinkSync(root, layout.varDir, "dir");
    expect(() => authority()).toThrow("file-authority-non-primary-checkout");
  });

  it("refuses an orphaned journal without an active marker", () => {
    const { authority, marker, path } = fixture();
    mkdirSync(join(path, "journal"), { recursive: true });
    expect(() => authority()).toThrow("file-authority-selector-missing");
    expect(() => authority(true)).toThrow("file-authority-selector-missing");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("activated fleet file authority", () => {
  it("replays and extends a real relocated workspace journal without moving its app bus", () => {
    const { layout: old, root } = storeFixture();
    const external = stateRootFixture(old);
    const bus = appLayout(old, GAME).busDir;
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "events.jsonl"), "Fixture event data\n");
    const registry = readRegistry(old);
    const original = Store.forLayout(TEST_CONTEXT, old);
    const record = (store: Store, key: string) =>
      recordSession(
        store,
        { nativeId: COORDINATOR, role: "game-coordinator" },
        { cwd: root, harness: "claude", key, version: "test" },
      );
    const first = record(original, "before-move");
    const before = original.verify();
    original.close();

    renameSync(old.configFile, `${old.configFile}.prior`);
    const moved = join(root, ".coordination-kit");
    mkdirSync(moved);
    for (const name of [
      "coordination",
      "coordination-authority.json",
      "coordination-authority.lock",
      "registry.json",
      "registry.lock",
      "work-protocol.json",
    ]) {
      renameSync(join(old.varDir, name), join(moved, name));
    }
    writeFileSync(join(root, ".gitignore"), "/var/\n/.coordination-kit/\n");
    writeFixtureJson(join(root, "coordination-kit.json"), {
      ...coordinatorConfig(),
      appStateRoot: "var",
    });
    const current = loadLayout(root);
    expect(readRegistry(current)).toEqual(registry);
    expect(legacyStorePath(current)).toBe(join(external, "coordination.db"));
    expect(appLayout(current, GAME).busDir).toBe(bus);
    expect(readFileSync(join(bus, "events.jsonl"), "utf8")).toBe("Fixture event data\n");
    const reopened = Store.forLayout(TEST_CONTEXT, current);
    try {
      expect(reopened.verify()).toEqual(before);
      expect(reopened.events()).toEqual([first]);
      const added = record(reopened, "after-move");
      expect(added.prevHash).toBe(before.head.hash);
      expect(reopened.verify().head).toEqual({ hash: added.hash, seq: before.head.seq + 1 });
      expect(existsSync(join(old.varDir, "coordination"))).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it.each([false, true])(
    "preserves the original receipt after moving a workspace with an external origin: %s",
    (external) => {
      const { layout: old, marker, path, root, witness } = fixture();
      if (external) {
        stateRootFixture(old);
      }
      const prepared = { ...PREPARED, legacyPath: legacyStorePath(old), root } as const;
      const active = { ...prepared, phase: "active" } as const;
      mkdirSync(path, { recursive: true });
      writeFixtureJson(marker, active);
      writeFixtureJson(witness, prepared);
      const moved = join(root, ".coordination-kit");
      renameSync(old.varDir, moved);
      writeFileSync(join(root, ".gitignore"), "/.coordination-kit/\n");
      writeFixtureJson(join(root, "coordination-kit.json"), coordinatorConfig());
      const current = loadLayout(root);
      const selected = fileAuthority(TEST_GIT, current, legacyStorePath(current));
      expect(selected).toEqual({
        kind: "files",
        path: join(moved, "coordination"),
        receipt: active,
      });
      expect(
        JSON.parse(readFileSync(join(moved, "coordination", "source-fence.json"), "utf8")),
      ).toEqual(prepared);
    },
  );

  it("recognizes the retained fleet evidence regardless of the legacy DB's presence", () => {
    const { active, authority, legacyPath, path } = activatedFixture();
    const expected = { kind: "files", path, receipt: active };
    expect(authority()).toEqual(expected);
    writeFileSync(legacyPath, "This content has never been a SQLite database");
    expect(authority()).toEqual(expected);
    expect(authority(true)).toEqual(expected);
    expect(readFileSync(legacyPath, "utf8")).toBe("This content has never been a SQLite database");
  });

  it("rejects a prepared-only selector and missing or mismatched witnesses", () => {
    const { active, authority, marker, prepared, witness } = activatedFixture();
    writeFixtureJson(marker, prepared);
    expect(() => authority(true)).toThrow("file-authority-cutover-pending");
    writeFixtureJson(marker, active);
    unlinkSync(witness);
    expect(() => authority()).toThrow("file-authority-source-fence-mismatch");
    writeFixtureJson(witness, { ...prepared, proof: "c".repeat(64) });
    expect(() => authority()).toThrow("file-authority-source-fence-mismatch");
  });

  it("rejects the original journal when its authority marker is lost", () => {
    const { authority, marker } = activatedFixture();
    unlinkSync(marker);
    expect(() => authority()).toThrow("file-authority-selector-missing");
    expect(() => authority(true)).toThrow("file-authority-selector-missing");
  });
});
