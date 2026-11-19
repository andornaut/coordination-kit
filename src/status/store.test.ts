import { describe, expect, it } from "vitest";

import { workBlock, workEvidence, workStart, workUnblock } from "../work/live.ts";
import { commit, IDS, KIT, live, liveFixture, workFile } from "../work/testLive.ts";
import { collectStatus, type StatusItem } from "./collect.ts";
import { systemGit } from "./git.ts";
import { sourceCounters } from "./sources.ts";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";

function status(root: string) {
  const env = { PATH: process.env.PATH };
  return collectStatus({ counters: sourceCounters(), git: systemGit(env), io: { env } }, root, {
    audit: false,
    scope: KIT,
    since: null,
    states: [],
    verifySince: "2026-11-19T02:00:00Z",
  });
}

function item(root: string, id: string): StatusItem {
  return status(root).items.find((entry) => entry.id === id)!;
}

describe("status with store work records", () => {
  it("reads store records as live state and prefers store evidence", () => {
    const fixture = liveFixture({
      kit: {
        "sk-0001": workFile("sk-0001", "Approved item", "approved"),
        "sk-0002": workFile("sk-0002", "Landed by Git", "approved"),
      },
    });
    commit(fixture.kit, "Implement sk-0002", { "src/a.ts": "a\n" });
    const before = status(fixture.root);
    expect(before.coordinator.store).toEqual({ status: "absent" });
    expect(item(fixture.root, "sk-0001")).toMatchObject({
      deliverySource: { deployment: null, landing: null },
      status: "approved",
      store: null,
    });
    expect(item(fixture.root, "sk-0002")).toMatchObject({
      deliverySource: { deployment: null, landing: "git" },
      status: "landed",
    });

    const kit = live(fixture, IDS.kit);
    const input = { id: "sk-0001", worktree: fixture.kit };
    workStart(kit, {}, input);
    expect(status(fixture.root).coordinator.store).toEqual({ status: "available" });
    expect(item(fixture.root, "sk-0001")).toMatchObject({
      blocked: false,
      status: "in-progress",
      store: { owner: KIT, state: "started" },
    });
    workBlock(kit, {}, { ...input, owner: "game-coordinator", reason: "Needs a release" });
    expect(item(fixture.root, "sk-0001")).toMatchObject({
      blocked: true,
      blocker: "Needs a release",
      owner: "game-coordinator",
    });
    workUnblock(kit, {}, input);
    workEvidence(kit, {}, { ...input, sha: SHA, stage: "merged" });
    expect(item(fixture.root, "sk-0001")).toMatchObject({
      blocked: false,
      deliverySource: { deployment: null, landing: "store" },
      status: "landed",
    });
    workEvidence(kit, {}, { ...input, ref: "release:v9.9.9", sha: SHA, stage: "published" });
    const published = item(fixture.root, "sk-0001");
    expect(published).toMatchObject({
      deliveryEvidence: "deployed",
      deliverySource: { deployment: "store", landing: "store" },
      deliveryVerified: true,
      status: "deployed",
    });
    expect(published.delivery.landing).toBeNull();
    expect(published.store?.evidence.map((entry) => entry.stage)).toEqual(["merged", "published"]);
  });
});
