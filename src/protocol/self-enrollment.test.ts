import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LedgerStore } from "../accounting/store.ts";
import type { LedgerSource } from "../accounting/types.ts";
import { loadLayout } from "../layout.ts";
import { createRegistry, type Registry } from "../registry/index.ts";
import { CLAUDE_COORDINATOR, CLAUDE_TECH, makeFixture, registryInput } from "../testFixtures.ts";
import { ProtocolStore } from "./core.ts";
import { EnrollmentStore } from "./enrollment.ts";
import { enrollSelf, NATIVE_ID_ENV } from "./self-enrollment.ts";

const AT = "2026-11-16T06:00:00.000Z";
const ROLE = "game-coordinator";
const NAMESPACE = "coordinator";
const SOURCE: LedgerSource = {
  native: null,
  origin: "owner-attested",
  reference: "fixture:approved-work",
  wordingHash: null,
};

function fixture() {
  const t = makeFixture();
  const layout = loadLayout(t.root);
  createRegistry(layout, registryInput() as unknown as Omit<Registry, "revision" | "updatedAt">);
  const stateRoot = join(t.base, "state");
  const protocol = new ProtocolStore({ directory: stateRoot, resolveBinding: () => true });
  const base = { generation: 1, phase: "active" as const, stateRoot, workspaceId: "fixture" };
  const enroll = (
    env: NodeJS.ProcessEnv,
    request: { role?: string; nativeId?: string; at?: string } = {},
  ) => enrollSelf({ env }, layout, protocol, base, { at: AT, role: ROLE, ...request });
  return { base, enroll, layout, protocol, stateRoot };
}

describe("protocol self-enrollment", () => {
  it("claims and enrolls the caller's own role from canonical state in the existing format", async () => {
    const t = fixture();
    const ledger = new LedgerStore({ directory: join(t.stateRoot, "accounting") });
    await ledger.apply({
      actor: ROLE,
      at: AT,
      command: {
        request: {
          assignment: null,
          dependencies: [],
          id: "request-one",
          kind: "request",
          parentId: null,
          question: null,
          reviewed: true,
          source: SOURCE,
          summary: "Fixture open request",
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
      commandId: "fixture-register",
      expectedRevision: 0,
      schema: 1,
      source: SOURCE,
    });
    const result = await t.enroll({ [NATIVE_ID_ENV.claude]: CLAUDE_COORDINATOR });
    expect(result.claimed).toEqual({ epoch: 1, revision: 1 });
    expect(result.context).toMatchObject({
      binding: { harness: "claude", nativeId: CLAUDE_COORDINATOR },
      epoch: 1,
      expectedRevision: 1,
      role: NAMESPACE,
    });
    expect(result.input.references).toEqual([{ key: "request-one", kind: "request" }]);
    expect(result.input.unknowns.map((value) => value.scope)).toEqual([
      "external-wip",
      "native-history",
      "worker-census",
    ]);
    expect(result.report.participants.find((p) => p.role === NAMESPACE)).toMatchObject({
      adopted: true,
      represented: true,
    });
    const record = new EnrollmentStore({ protocol: t.protocol }).read(NAMESPACE)!;
    expect(Object.keys(record).sort()).toEqual(
      [
        "binding",
        "epoch",
        "evidence",
        "generation",
        "inspectedAt",
        "ledger",
        "phase",
        "references",
        "registryRevision",
        "role",
        "schema",
        "unknowns",
        "workspaceId",
      ].sort(),
    );
    const evidence = JSON.parse(
      Buffer.from(t.protocol.readArtifact(record.evidence[0]!.hash)).toString(),
    );
    expect(evidence).toMatchObject({
      command: "protocol enroll-self",
      notVerified: expect.arrayContaining(["caller-process-identity"]),
      role: NAMESPACE,
    });

    // A later run refreshes the receipt under the existing epoch, with the supplied native ID.
    const again = await t.enroll({}, { nativeId: CLAUDE_COORDINATOR });
    expect(again.claimed).toBeNull();
    expect(again.context).toMatchObject({ epoch: 1, expectedRevision: 2 });
    expect(t.protocol.read(NAMESPACE).epoch).toBe(1);
  });

  it("refuses another role, an unverified native ID and a journal held under another binding", async () => {
    const t = fixture();
    const env = { [NATIVE_ID_ENV.claude]: CLAUDE_COORDINATOR };
    const unverified = { code: "enrollment-caller-unverified" };
    await expect(t.enroll(env, { role: "archies-dog-walks/tech" })).rejects.toMatchObject(
      unverified,
    );
    await expect(t.enroll(env, { role: "unregistered-role" })).rejects.toMatchObject(unverified);
    await expect(t.enroll({})).rejects.toMatchObject(unverified);
    await expect(t.enroll({}, { nativeId: CLAUDE_TECH })).rejects.toMatchObject(unverified);
    await expect(t.enroll(env, { nativeId: CLAUDE_TECH })).rejects.toMatchObject(unverified);
    await expect(t.enroll({ [NATIVE_ID_ENV.codex]: CLAUDE_COORDINATOR })).rejects.toMatchObject(
      unverified,
    );
    expect(t.protocol.listRoles({ includeWorkers: true })).toEqual([]);

    await t.protocol.claim({
      at: AT,
      binding: { harness: "claude", nativeId: CLAUDE_TECH },
      evidence: "fixture:prior-owner",
      expectedEpoch: 0,
      role: NAMESPACE,
    });
    await expect(t.enroll(env)).rejects.toMatchObject({ code: "enrollment-claim-required" });
    expect(t.protocol.read(NAMESPACE)).toMatchObject({ epoch: 1, revision: 1 });
  });
});
