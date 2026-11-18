import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LedgerStore } from "../accounting/store.ts";
import type { LedgerSource } from "../accounting/types.ts";
import { EXIT_INVALID, EXIT_OK, main } from "../cli.ts";
import { loadLayout } from "../layout.ts";
import { ProtocolStore } from "../protocol/core.ts";
import { activateProtocolFixture } from "../protocol/testFixtures.ts";
import { WorkStore } from "../protocol/work.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, makeFixture, registryInput } from "../testFixtures.ts";
import { reportWork } from "./report.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "delivery-kit");
const AT = "2026-11-18T06:00:00.000Z";
const ROLE = "coordinator";
const BINDING = { harness: "claude" as const, nativeId: CLAUDE_COORDINATOR };
const SOURCE: LedgerSource = {
  native: null,
  origin: "owner-attested",
  reference: "fixture:approved-work",
  wordingHash: null,
};

function coordinator(): string {
  const { root } = makeFixture();
  createRegistry(
    loadLayout(root),
    registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">,
  );
  return root;
}

/** An active protocol fixture whose coordinator publishes work `id` for ledger request `request`. */
async function published(
  id: string,
  request: string,
  reference: { readonly path?: string; readonly commit?: string } = {},
): Promise<string> {
  const root = coordinator();
  const stateRoot = activateProtocolFixture(loadLayout(root));
  const protocol = new ProtocolStore({ directory: stateRoot, resolveBinding: () => true });
  await protocol.claim({
    at: AT,
    binding: BINDING,
    evidence: "fixture:owner",
    expectedEpoch: 0,
    role: ROLE,
  });
  const ledger = new LedgerStore({ directory: join(stateRoot, "accounting") });
  await ledger.apply({
    actor: "game-coordinator",
    at: AT,
    command: {
      request: {
        assignment: null,
        dependencies: [],
        id: request,
        kind: "request",
        parentId: null,
        question: null,
        reviewed: true,
        source: SOURCE,
        summary: "Fixture approved work",
        targets: [
          {
            consumers: [],
            criteria: [{ description: "Checked", id: "check", requiredEvidence: ["check"] }],
            description: "Exact source",
            id: "target",
          },
        ],
      },
      type: "register",
    },
    commandId: "register-fixture",
    expectedRevision: 0,
    schema: 1,
    source: SOURCE,
  });
  const work = new WorkStore({ protocol, readRequest: (key) => ledger.read(key) });
  await work.publish(
    {
      at: AT,
      binding: BINDING,
      epoch: protocol.read(ROLE).epoch,
      expectedRevision: protocol.read(ROLE).revision,
      id: `publish-${id}`,
      role: ROLE,
    },
    {
      definition: {
        artifacts: [await protocol.putArtifact(Buffer.from("fixture essential source"))],
        clauseIds: [],
        criteria: [{ consumers: [], id: "check", phases: ["check"], targetId: "target" }],
        id,
        messageIds: [],
        plan: { ...(await protocol.putArtifact(Buffer.from("fixture plan"))), ...reference },
        requestIds: [request],
        retention: null,
        source: null,
      },
      expectedWorkRevision: 0,
      ready: false,
      replaces: null,
    },
  );
  return root;
}

describe("reportWork", () => {
  it("reports front matter only without a coordinator root", () => {
    const report = reportWork({ env: {} }, undefined, FIXTURE);
    expect(report.coordinator).toEqual({ status: "absent" });
    expect(report.items).toHaveLength(18);
    expect(report.items[0]).toEqual({
      design: "review",
      id: "dk-0001",
      path: "docs/work/dk-0001.md",
      status: "done",
      title: "Accept Claude route targets in inbox snapshot and ack",
    });
    expect(report.items.find((item) => item.id === "dk-0018")?.status).toBe("approved");
    expect(report.items.some((item) => "publications" in item)).toBe(false);
  });

  it("names an unconfigured protocol and keeps front matter only", () => {
    const root = coordinator();
    const report = reportWork({ env: {} }, root, FIXTURE);
    expect(report.coordinator).toEqual({ root, status: "unconfigured" });
    expect(report.items.some((item) => "publications" in item)).toBe(false);
  });

  it("joins each item with its work publications, receipts and ledger state", async () => {
    const root = await published("dk-0018", "request-split");
    const report = reportWork({ env: {} }, root, FIXTURE);
    expect(report.coordinator).toEqual({ root, status: "available" });
    expect(report.items.find((item) => item.id === "dk-0018")?.publications).toEqual([
      {
        joinedBy: ["id"],
        plan: { commit: null, path: null },
        ready: false,
        receiptsSatisfied: false,
        requests: [{ id: "request-split", state: expect.any(String) }],
        revision: 1,
        role: ROLE,
      },
    ]);
    const state = report.items.find((item) => item.id === "dk-0018")?.publications?.[0]?.requests[0]
      ?.state;
    expect(state).not.toBe("unknown");
    expect(report.items.find((item) => item.id === "dk-0001")?.publications).toEqual([]);
  });

  it("joins a publication by its plan path and commit as well as by ID", async () => {
    const commit = "e".repeat(40);
    const byPath = await published("split-work", "request-split", {
      commit,
      path: "docs/work/dk-0018.md",
    });
    const report = reportWork({ env: {} }, byPath, FIXTURE);
    expect(report.items.find((item) => item.id === "dk-0018")?.publications).toMatchObject([
      { joinedBy: ["path"], plan: { commit, path: "docs/work/dk-0018.md" }, role: ROLE },
    ]);
    expect(report.items.flatMap((item) => item.publications ?? [])).toHaveLength(1);

    const both = await published("dk-0018", "request-split", { path: "docs/work/dk-0018.md" });
    expect(
      reportWork({ env: {} }, both, FIXTURE).items.find((item) => item.id === "dk-0018")
        ?.publications,
    ).toMatchObject([{ joinedBy: ["id", "path"], plan: { commit: null } }]);

    const elsewhere = await published("dk-0018", "request-split", { path: "docs/work/dk-0001.md" });
    const split = reportWork({ env: {} }, elsewhere, FIXTURE).items;
    expect(split.find((item) => item.id === "dk-0018")?.publications).toMatchObject([
      { joinedBy: ["id"] },
    ]);
    expect(split.find((item) => item.id === "dk-0001")?.publications).toMatchObject([
      { joinedBy: ["path"] },
    ]);
  });

  it("reports an unreadable coordinator as unavailable, never as absent work", async () => {
    const report = reportWork({ env: {} }, "/nonexistent/coordinator", FIXTURE);
    expect(report.coordinator).toMatchObject({ status: "unavailable" });
    expect(report.items.some((item) => "publications" in item)).toBe(false);
    let out = "";
    const code = await main(
      {
        cwd: FIXTURE,
        env: { DELIVERY_KIT_ROOT: "/nonexistent/coordinator" },
        err: () => undefined,
        out: (text) => (out += text),
      },
      ["work", "report"],
    );
    expect(code).toBe(EXIT_INVALID);
    expect(JSON.parse(out).coordinator.status).toBe("unavailable");
  });

  it("reads the coordinator root from COORDINATION_KIT_ROOT before DELIVERY_KIT_ROOT", async () => {
    const root = coordinator();
    let out = "";
    const code = await main(
      {
        cwd: "/nonexistent",
        env: { COORDINATION_KIT_ROOT: root, DELIVERY_KIT_ROOT: "/nonexistent/coordinator" },
        err: () => undefined,
        out: (text) => (out += text),
      },
      ["work", "report", "--root", FIXTURE],
    );
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(out).coordinator).toEqual({ root, status: "unconfigured" });
  });
});
