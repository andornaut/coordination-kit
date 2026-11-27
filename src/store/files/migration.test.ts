import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TEST_CONTEXT, TEST_GIT } from "../../core/testFixtures.ts";
import { Store, storePath } from "../db.ts";
import { openQuestion, setHold } from "../decisions/questions.ts";
import { canonicalJson } from "../eventCodec.ts";
import { messageStatus, readInbox, sendMessage } from "../messages/messages.ts";
import { COORDINATOR, GAME, storeFixture, TECH } from "../testStore.ts";
import { inspectFileAuthority } from "./authority.ts";
import { activateMigration, prepareMigration } from "./migration.ts";

const SENDER = { nativeId: COORDINATOR, role: "game-coordinator" };
const RECIPIENT = { nativeId: TECH, role: `${GAME}/tech` };
const MESSAGE = "00000000-0000-4000-8000-0000000000a1";

function fixture() {
  const { base, layout, root } = storeFixture();
  execFileSync("git", ["-C", root, "init", "-q", "--initial-branch=main"]);
  writeFileSync(join(root, ".gitignore"), "/var/\n");
  writeFileSync(
    join(layout.varDir, "work-protocol.json"),
    canonicalJson({ schema: 2, stateRoot: join(base, "external-state") }),
  );
  const legacy = Store.forLayout(TEST_CONTEXT, layout);
  sendMessage(legacy, SENDER, {
    body: "Fixture message",
    id: MESSAGE,
    intent: "queue",
    to: RECIPIENT.role,
  });
  openQuestion(legacy, RECIPIENT, { id: "question-fixture", title: "Fixture decision" });
  setHold(legacy, RECIPIENT, { id: "hold-fixture", reason: "Fixture hold", scope: "role" });
  const target = join(layout.varDir, "coordination");
  return { base, layout, legacy, target };
}

describe("filesystem migration", () => {
  it("copies and restores independently, then switches normal reads and writes exactly once", () => {
    const { base, layout, legacy, target } = fixture();
    const source = storePath(layout);
    const before = legacy.head();
    const prepared = prepareMigration(
      TEST_GIT,
      layout,
      join(base, "backup.db"),
      join(base, "restore.db"),
    );
    try {
      expect(prepared.receipt.head).toEqual(before);
      expect(inspectFileAuthority(TEST_GIT, layout, source).kind).toBe("sqlite");
      const original = join(
        target,
        "roles",
        SENDER.role,
        "messages",
        "originals",
        `${MESSAGE}.json`,
      );
      const immutableBytes = readFileSync(original);
      expect(JSON.parse(immutableBytes.toString()).payload.body).toBe("Fixture message");

      const active = activateMigration(TEST_GIT, layout, prepared.receipt.id);
      expect(active.phase).toBe("active");
      expect(activateMigration(TEST_GIT, layout, active.id)).toEqual(active);
      expect(() => readInbox(legacy, RECIPIENT)).toThrow("store-authority-frozen");

      const store = Store.forLayout(TEST_CONTEXT, layout);
      try {
        expect(store.fileBacked).toBe(true);
        expect(store.head()).toEqual(before);
        expect(readInbox(store, RECIPIENT).messages.map(({ id }) => id)).toEqual([MESSAGE]);
      } finally {
        store.close();
      }
      const reader = Store.readLayout(TEST_CONTEXT, layout)!;
      try {
        expect(messageStatus(reader, MESSAGE).state).toBe("delivered");
        expect(legacy.head()).toEqual(before);
        expect(readFileSync(original)).toEqual(immutableBytes);
        expect(reader.verify().events).toBeGreaterThan(before.seq);
      } finally {
        reader.close();
      }
    } finally {
      legacy.close();
    }
  });

  it("refuses stale qualification and safely extends an inactive candidate from an exact prefix", () => {
    const { base, layout, legacy } = fixture();
    try {
      const first = prepareMigration(
        TEST_GIT,
        layout,
        join(base, "backup.db"),
        join(base, "restore.db"),
      );
      readInbox(legacy, RECIPIENT);
      expect(() => activateMigration(TEST_GIT, layout, first.receipt.id)).toThrow(
        "file-authority-source-head-changed",
      );
      const second = prepareMigration(
        TEST_GIT,
        layout,
        join(base, "backup-2.db"),
        join(base, "restore-2.db"),
      );
      expect(second.receipt.head).toEqual(legacy.head());
      expect(second.receipt.id).not.toBe(first.receipt.id);
      expect(() => activateMigration(TEST_GIT, layout, first.receipt.id)).toThrow(
        "file-authority-cutover-receipt-mismatch",
      );
      expect(activateMigration(TEST_GIT, layout, second.receipt.id).phase).toBe("active");
    } finally {
      legacy.close();
    }
  });

  it("refuses a backup inside the primary checkout before preparing anything", () => {
    const { base, layout, legacy, target } = fixture();
    try {
      expect(() =>
        prepareMigration(
          TEST_GIT,
          layout,
          join(layout.varDir, "backup.db"),
          join(base, "restore.db"),
        ),
      ).toThrow("migration-backup-inside-checkout");
      expect(existsSync(target)).toBe(false);
    } finally {
      legacy.close();
    }
  });

  it("refuses unjournaled projection drift even when the SQLite head has not moved", () => {
    const { base, layout, legacy } = fixture();
    try {
      const prepared = prepareMigration(
        TEST_GIT,
        layout,
        join(base, "backup.db"),
        join(base, "restore.db"),
      );
      legacy.db
        .prepare("UPDATE questions SET title = ? WHERE id = ?")
        .run("Drift", "question-fixture");
      expect(legacy.head()).toEqual(prepared.receipt.head);
      expect(() => activateMigration(TEST_GIT, layout, prepared.receipt.id)).toThrow(
        "snapshot-projection-mismatch",
      );
      expect(inspectFileAuthority(TEST_GIT, layout, storePath(layout)).kind).toBe("sqlite");
    } finally {
      legacy.close();
    }
  });
});
