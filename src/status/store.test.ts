import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLayout } from "../core/configuration/layout.ts";
import { systemGit } from "../core/git.ts";
import { TEST_CONTEXT } from "../core/testFixtures.ts";
import { Store } from "../store/db.ts";
import {
  workBlock,
  workEvidence,
  workFinish,
  workReady,
  workStart,
  workUnblock,
} from "../work/live.ts";
import { commit, GAME, IDS, KIT, live, liveFixture, workFile } from "../work/testLive.ts";
import { collectStatus, type StatusItem } from "./collect.ts";

const SHA = "abcdef0123456789abcdef0123456789abcdef01";

function status(root: string, scope = KIT) {
  const env = { PATH: process.env.PATH };
  return collectStatus({ git: systemGit(env), io: { env } }, root, {
    audit: false,
    scope,
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
      delivery: { landing: { rule: "id" } },
      deliverySource: { deployment: null, landing: null },
      status: "approved",
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

  it("keeps an open Ada the Navigator work item in progress when only gameplay specification history cites it", () => {
    const id = "ada-0303";
    const fixture = liveFixture({
      game: {
        [id]: workFile(id, "Implement the approved work", "approved"),
        "ada-0304": workFile("ada-0304", "An independently completed item", "approved"),
      },
    });
    workStart(live(fixture, IDS.tech), {}, { id, worktree: fixture.game });
    const citation = commit(fixture.game, `Clarify gameplay dependencies for ${id}`, {
      "gameplay/economy.md": "Economy specification\n",
      "gameplay/ships.md": "Ship specification\n",
    });
    const bus = join(fixture.root, "var", "games", GAME, "bus");
    mkdirSync(bus, { recursive: true });
    writeFileSync(join(bus, "last-deploy.sha"), `${citation}\n`);
    writeFileSync(join(bus, "last-deploy"), "1795039200\n");
    const completed = commit(fixture.game, "Complete a separate item", {
      "docs/work/ada-0304.md": workFile("ada-0304", "An independently completed item", "done"),
    });
    const deploy = (type: string, status: string) => {
      const store = Store.forLayout(TEST_CONTEXT, loadLayout(fixture.root));
      try {
        store.append({
          actor: { nativeId: null, role: "delivery-kit" },
          key: `bus.event:${type}`,
          kind: "bus.event",
          payload: {
            at: "2026-11-23T02:00:00.000Z",
            game: GAME,
            id: type,
            key: completed,
            kind: "deploy",
            sha: completed,
            status,
            type,
            work: ["ada-0304"],
          },
        });
      } finally {
        store.close();
      }
    };

    const entry = status(fixture.root, GAME).items.find((work) => work.id === id);
    expect(entry).toMatchObject({
      delivery: {
        deployed: null,
        heuristicDeployment: { sha: citation, via: "last-deploy" },
        landing: { rule: "id", sha: citation },
      },
      deliverySource: { deployment: null, landing: null },
      deliveryVerified: null,
      status: "in-progress",
      store: { evidence: [], state: "started" },
      workFile: { status: "approved" },
    });

    deploy("deploy_skipped", "skipped");
    expect(status(fixture.root, GAME).items.find((work) => work.id === "ada-0304")).toMatchObject({
      delivery: { deployed: null },
    });
    deploy("deploy_success", "ok");
    expect(status(fixture.root, GAME).items.find((work) => work.id === "ada-0304")).toMatchObject({
      delivery: { deployed: { matched: "landing", sha: completed, via: "deploy-event" } },
      deliveryVerified: true,
    });

    commit(fixture.game, "Remove an obsolete path", { [`docs/work/${id}.md`]: null });
    expect(status(fixture.root, GAME).items.find((work) => work.id === id)).toMatchObject({
      id,
      status: "in-progress",
      store: { state: "started" },
      workFile: null,
    });
  });

  it("closes a finished superseded item and keeps its status without the work file", () => {
    const fixture = liveFixture({
      kit: {
        "sk-0001": workFile("sk-0001", "Replaced item", "approved"),
        "sk-0002": workFile("sk-0002", "Successor", "approved", { supersedes: "sk-0001" }),
      },
    });
    const kit = live(fixture, IDS.kit);
    const input = { id: "sk-0001", worktree: fixture.kit };
    workStart(kit, {}, input);
    workReady(kit, {}, input);
    commit(fixture.kit, "Supersede sk-0001", {
      "docs/work/sk-0001.md": workFile("sk-0001", "Replaced item", "superseded"),
    });
    workFinish(kit, {}, input);
    expect(item(fixture.root, "sk-0001")).toMatchObject({
      replacement: "sk-0002",
      status: "superseded",
      store: { finishedStatus: "superseded", state: "finished", successors: ["sk-0002"] },
    });
    commit(fixture.kit, "Remove sk-0001", { "docs/work/sk-0001.md": null });
    expect(item(fixture.root, "sk-0001")).toMatchObject({
      replacement: "sk-0002",
      status: "superseded",
      workFile: null,
    });
  });
});
