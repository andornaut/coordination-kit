import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadLayout } from "../../core/layout.ts";
import { Store } from "../db.ts";
import { GENESIS } from "../types.ts";
import {
  activateFileAuthority,
  type CutoverEvidence,
  fileAuthority,
  fileAuthorityTarget,
  inspectFileAuthority,
  prepareFileAuthority,
} from "./authority.ts";

const CONFIG = {
  games: {},
  kits: {},
  schema: 1,
  sharedRoles: ["game-coordinator"],
  timezone: "America/Toronto",
  wakeMinutes: [],
};
const PROOF = "a".repeat(64);
const EVIDENCE: CutoverEvidence = { head: { hash: GENESIS, seq: 0 }, proof: PROOF };

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}

function fixture() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "file-authority-")));
  const root = join(scratch, "coordinator");
  mkdirSync(root);
  git(root, "init", "-q", "--initial-branch=main");
  writeFileSync(join(root, ".gitignore"), "/var/\n");
  writeFileSync(join(root, "config.json"), JSON.stringify(CONFIG));
  git(root, "add", ".gitignore", "config.json");
  git(
    root,
    "-c",
    "user.name=Test Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Fixture",
  );
  const layout = loadLayout(root);
  const target = join(layout.varDir, "coordination");
  mkdirSync(target, { recursive: true });
  const selector = join(layout.varDir, "coordination-authority.json");
  const source = join(scratch, "external", "coordination.db");
  const store = Store.open(source);
  store.close();
  return { layout, scratch, selector, source, target };
}

function append(store: Store, key: string) {
  return store.append({
    actor: { nativeId: null, role: null },
    key,
    kind: "test.event",
    payload: {},
  });
}

describe("filesystem authority", () => {
  it("keeps SQLite authoritative while a validated candidate is prepared", () => {
    const { layout, selector, source, target } = fixture();
    const verify = vi.fn();
    expect(fileAuthority(layout, source)).toEqual({ kind: "sqlite", path: source });
    expect(existsSync(selector)).toBe(false);
    const receipt = prepareFileAuthority(layout, source, EVIDENCE, verify);
    expect(receipt).toMatchObject({
      ...EVIDENCE,
      legacyPath: source,
      phase: "prepared",
      root: layout.root,
    });
    expect(verify).toHaveBeenCalledWith(target, receipt, expect.anything());
    expect(inspectFileAuthority(layout, source)).toEqual({ kind: "sqlite", path: source, receipt });
    expect(fileAuthority(layout, source)).toEqual({ kind: "sqlite", path: source });
    expect(prepareFileAuthority(layout, source, EVIDENCE, verify)).toEqual(receipt);
  });

  it("creates an ignored primary candidate directory with private permissions", () => {
    const { layout, scratch, target } = fixture();
    renameSync(target, join(scratch, "initial-target"));
    expect(() => fileAuthorityTarget(layout)).toThrow("file-authority-target-directory");
    expect(fileAuthorityTarget(layout, { create: true })).toBe(target);
    expect(statSync(target).mode & 0o777).toBe(0o700);

    const linked = join(scratch, "linked");
    git(layout.root, "worktree", "add", "--detach", linked);
    const alternateLayout = loadLayout(linked);
    mkdirSync(alternateLayout.varDir);
    expect(() => fileAuthorityTarget(alternateLayout, { create: true })).toThrow(
      "file-authority-non-primary-checkout",
    );
    expect(existsSync(join(alternateLayout.varDir, "coordination"))).toBe(false);

    renameSync(target, join(scratch, "private-target"));
    writeFileSync(join(layout.root, ".gitignore"), "/unrelated/\n");
    expect(() => fileAuthorityTarget(layout, { create: true })).toThrow(
      "file-authority-non-primary-checkout",
    );
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a linked worktree, an alias of the checkout and symlinks at var or target", () => {
    const { layout, scratch, source, target } = fixture();
    const linked = join(scratch, "linked");
    git(layout.root, "worktree", "add", "--detach", linked);
    mkdirSync(join(linked, "var", "coordination"), { recursive: true });
    const verify = vi.fn();
    expect(() => prepareFileAuthority(loadLayout(linked), source, EVIDENCE, verify)).toThrow(
      "file-authority-non-primary-checkout",
    );
    const alias = join(scratch, "alias");
    symlinkSync(layout.root, alias, "dir");
    expect(() => prepareFileAuthority(loadLayout(alias), source, EVIDENCE, verify)).toThrow(
      "file-authority-non-primary-checkout",
    );
    const original = join(scratch, "target");
    renameSync(target, original);
    symlinkSync(original, target, "dir");
    expect(() => prepareFileAuthority(layout, source, EVIDENCE, verify)).toThrow(
      "file-authority-target-directory",
    );
    const detachedVar = join(scratch, "var");
    renameSync(layout.varDir, detachedVar);
    symlinkSync(detachedVar, layout.varDir, "dir");
    expect(() => prepareFileAuthority(layout, source, EVIDENCE, verify)).toThrow(
      "file-authority-non-primary-checkout",
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it("qualifies the final source head and refuses the older evidence after a concurrent append", () => {
    const { layout, source } = fixture();
    const verify = vi.fn();
    const first = prepareFileAuthority(layout, source, EVIDENCE, verify);
    const legacy = Store.open(source);
    try {
      append(legacy, "one");
      expect(() => activateFileAuthority(layout, source, first.id, verify)).toThrow(
        "file-authority-source-head-changed",
      );
      expect(fileAuthority(layout, source)).toEqual({ kind: "sqlite", path: source });
      const second = prepareFileAuthority(
        layout,
        source,
        { head: legacy.head(), proof: PROOF },
        verify,
      );
      expect(second.id).not.toBe(first.id);
      expect(() => activateFileAuthority(layout, source, first.id, verify)).toThrow(
        "file-authority-cutover-receipt-mismatch",
      );
      const active = activateFileAuthority(layout, source, second.id, verify);
      expect(active.head).toEqual(legacy.head());
      expect(() => append(legacy, "two")).toThrow("store-authority-frozen");
      expect(legacy.events().map((event) => event.key)).toEqual(["one"]);
    } finally {
      legacy.close();
    }
  });

  it("recovers an interruption after the SQLite fence with the original receipt", () => {
    const { layout, source, target } = fixture();
    const verify = vi.fn();
    const receipt = prepareFileAuthority(layout, source, EVIDENCE, verify);
    const preUpgrade = Store.open(source);
    try {
      expect(() =>
        activateFileAuthority(layout, source, receipt.id, verify, {
          onFrozen: () => {
            expect(() => append(preUpgrade, "late")).toThrow("store-authority-frozen");
            expect(() => fileAuthority(layout, source)).toThrow("file-authority-cutover-pending");
            expect(inspectFileAuthority(layout, source)).toEqual({
              kind: "pending",
              path: target,
              receipt,
            });
            throw new Error("interrupted");
          },
        }),
      ).toThrow("interrupted");
      expect(() =>
        activateFileAuthority(layout, source, receipt.id, () => {
          throw new Error("proof mismatch");
        }),
      ).toThrow("proof mismatch");
      expect(() => fileAuthority(layout, source)).toThrow("file-authority-cutover-pending");

      const active = activateFileAuthority(layout, source, receipt.id, verify);
      expect(active).toEqual({ ...receipt, phase: "active" });
      expect(fileAuthority(layout, source)).toEqual({
        kind: "files",
        path: target,
        receipt: active,
      });
      verify.mockClear();
      expect(activateFileAuthority(layout, source, receipt.id, verify)).toEqual(active);
      expect(verify).not.toHaveBeenCalled();
    } finally {
      preUpgrade.close();
    }
  });

  it("excludes a competing legacy writer throughout final proof checking", () => {
    const { layout, source } = fixture();
    const receipt = prepareFileAuthority(layout, source, EVIDENCE, vi.fn());
    const inspectCompetingWriter = () => {
      const script = `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(process.argv[1], { timeout: 50 });
        try {
          db.exec("BEGIN IMMEDIATE");
          process.exitCode = 1;
        } catch (error) {
          if (error.errcode !== 5) throw error;
        } finally {
          db.close();
        }
      `;
      execFileSync(process.execPath, ["--input-type=module", "--eval", script, source], {
        stdio: "pipe",
      });
    };
    expect(activateFileAuthority(layout, source, receipt.id, inspectCompetingWriter).phase).toBe(
      "active",
    );
  });

  it("leaves SQLite writable if proof verification returns unfinished async work", () => {
    const { layout, source } = fixture();
    const receipt = prepareFileAuthority(layout, source, EVIDENCE, vi.fn());
    expect(() => activateFileAuthority(layout, source, receipt.id, async () => {})).toThrow(
      "file-authority-proof-async",
    );
    expect(fileAuthority(layout, source)).toEqual({ kind: "sqlite", path: source });
    const legacy = Store.open(source);
    try {
      expect(append(legacy, "still-live").duplicate).toBe(false);
    } finally {
      legacy.close();
    }
  });

  it("requires the target fence witness to be the original regular file", () => {
    const { layout, scratch, source, target } = fixture();
    const verify = vi.fn();
    const receipt = prepareFileAuthority(layout, source, EVIDENCE, verify);
    activateFileAuthority(layout, source, receipt.id, verify);
    const witness = join(target, "source-fence.json");
    const original = join(scratch, "target-fence");
    renameSync(witness, original);
    expect(() => fileAuthority(layout, source)).toThrow("file-authority-source-fence-mismatch");
    symlinkSync(original, witness);
    expect(() => fileAuthority(layout, source)).toThrow("file-authority-selector-invalid");
  });

  it("rejects a lost selector with both the original source and an unfenced replacement", () => {
    const { layout, scratch, selector, source } = fixture();
    const verify = vi.fn();
    const receipt = prepareFileAuthority(layout, source, EVIDENCE, verify);
    activateFileAuthority(layout, source, receipt.id, verify);
    renameSync(selector, join(scratch, "saved-selector"));
    expect(() => fileAuthority(layout, source)).toThrow("file-authority-selector-missing");
    renameSync(source, join(scratch, "saved-source"));
    const replacement = Store.open(source);
    replacement.close();
    expect(() => fileAuthority(layout, source)).toThrow("file-authority-selector-missing");
  });

  it("fails closed on a corrupt active selector or a removed frozen trigger", () => {
    const { layout, scratch, selector, source } = fixture();
    const verify = vi.fn();
    const receipt = prepareFileAuthority(layout, source, EVIDENCE, verify);
    activateFileAuthority(layout, source, receipt.id, verify);
    const original = join(scratch, "saved-selector");
    renameSync(selector, original);
    writeFileSync(selector, "{}");
    expect(() => fileAuthority(layout, source)).toThrow("file-authority-selector-invalid");
    renameSync(original, selector);

    const legacy = Store.open(source);
    try {
      legacy.db.exec("DROP TRIGGER coordination_file_authority_no_insert");
      expect(() => fileAuthority(layout, source)).toThrow("file-authority-source-fence-invalid");
    } finally {
      legacy.close();
    }
  });

  it("uses the source binding to refuse a second standalone clone after activation", () => {
    const { layout, source } = fixture();
    const alternate = fixture();
    const verify = vi.fn();
    const receipt = prepareFileAuthority(layout, source, EVIDENCE, verify);
    activateFileAuthority(layout, source, receipt.id, verify);
    expect(() => fileAuthority(alternate.layout, source)).toThrow(
      "file-authority-selector-missing",
    );
    expect(() => prepareFileAuthority(alternate.layout, source, EVIDENCE, verify)).toThrow(
      "file-authority-already-fenced",
    );
  });
});
