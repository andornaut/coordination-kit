import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLayout } from "../../core/configuration/layout.ts";
import { coordinatorConfig, TEST_GIT, writeFixtureJson } from "../../core/testFixtures.ts";
import { GENESIS } from "../types.ts";
import { type CutoverReceipt, fileAuthority } from "./authority.ts";

function fixture(standalone = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "file-authority-")));
  TEST_GIT(root, ["init", "-q", "--initial-branch=main"]);
  const name = standalone ? ".coordination-kit" : "var";
  writeFileSync(join(root, ".gitignore"), `/${name}/\n`);
  if (standalone) {
    writeFixtureJson(join(root, "coordination-kit.json"), {
      project: { id: "fixture", roles: ["maintainer"] },
      review: "off",
      schema: 1,
    });
  } else {
    writeFixtureJson(join(root, "config.json"), coordinatorConfig());
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
  it.each([false, true])("creates only on write with standalone %s", (standalone) => {
    const { authority, layout, legacyPath, marker, path, root, witness } = fixture(standalone);
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
  });

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
