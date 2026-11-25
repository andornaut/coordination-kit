import { describe, expect, it, vi } from "vitest";

import { TEST_CLOCK } from "../../core/testFixtures.ts";
import type { Registry } from "../../registry/schema.ts";
import { readRegistry } from "../../registry/store.ts";
import { Store } from "../db.ts";
import { DELIVERY_KIT_ACTOR, resolveCaller } from "../identity.ts";
import { ART, COORDINATOR, GAME, storeFixture, TECH } from "../testStore.ts";
import type { JsonObject, StoredEvent } from "../types.ts";
import { verifiedWorkerForCaller, verifiedWorkerForEvent } from "./workerProof.ts";

const CHILD = "00000000-0000-4000-8000-0000000000d4";
const OTHER = "00000000-0000-4000-8000-0000000000d5";
const ART_ROLE = `${GAME}/art`;
const TECH_ROLE = `${GAME}/tech`;
const SLOT_AT = "2026-11-21T15:30:00.000Z";
const REVIEW_AT = "2026-11-21T15:30:03.000Z";
const EVENT_AT = "2026-11-21T16:00:00.000Z";
const NEXT_SLOT_AT = "2026-11-21T16:30:00.000Z";

const worker = (role: string, parentNativeId: string) => ({
  lineage: { parentNativeId, workerNativeIds: [CHILD] },
  role,
});

function reviewed(
  registry: Registry,
  workers: readonly JsonObject[] = [worker(ART_ROLE, ART)],
): StoredEvent {
  const store = Store.open(TEST_CLOCK, ":memory:");
  try {
    return store.append({
      actor: DELIVERY_KIT_ACTOR,
      at: REVIEW_AT,
      key: "review.brief:archie:slot",
      kind: "review.brief",
      payload: {
        game: GAME,
        messageId: OTHER,
        native: { registryRevision: registry.revision, workers },
        recipient: "game-coordinator",
        result: { status: "delivered" },
        slot: Date.parse(SLOT_AT) / 1000,
      },
    }).event;
  } finally {
    store.close();
  }
}

describe("worker proof from a stored scheduled review", () => {
  const registry = () => readRegistry(storeFixture().layout);

  it("binds an environment child but never promotes an explicit ID or a worker label", () => {
    const roles = registry();
    const review = reviewed(roles);
    const prove = vi.fn((id: string) => verifiedWorkerForCaller(roles, review, EVENT_AT, id));
    expect(() => resolveCaller(roles, { CODEX_THREAD_ID: CHILD })).toThrow("caller-unbound");
    expect(() =>
      resolveCaller(roles, { CODEX_THREAD_ID: CHILD }, { nativeId: CHILD }, prove),
    ).toThrow("caller-unbound");
    expect(resolveCaller(roles, { CODEX_THREAD_ID: ART }, { worker: CHILD }, prove)).toEqual({
      nativeId: ART,
      role: ART_ROLE,
      worker: CHILD,
    });
    expect(prove).not.toHaveBeenCalled();
    expect(resolveCaller(roles, { CODEX_THREAD_ID: CHILD }, {}, prove)).toEqual({
      nativeId: CHILD,
      role: ART_ROLE,
    });
    expect(prove).toHaveBeenCalledExactlyOnceWith(CHILD);
    const mixed = { CLAUDE_CODE_SESSION_ID: COORDINATOR, CODEX_THREAD_ID: CHILD };
    expect(() => resolveCaller(roles, mixed, {}, prove)).toThrow("caller-ambiguous");
    expect(resolveCaller(roles, mixed, { nativeId: COORDINATOR }, prove)).toEqual({
      nativeId: COORDINATOR,
      role: "game-coordinator",
    });
    expect(() => resolveCaller(roles, { CODEX_THREAD_ID: OTHER }, {}, prove)).toThrow(
      "caller-unbound",
    );
  });

  it("needs an exact current binding and an unambiguous genuine review within its slot", () => {
    const roles = registry();
    const review = reviewed(roles);
    const proof = {
      evidenceSha256: review.hash,
      parentNativeId: ART,
      parentRole: ART_ROLE,
      registryRevision: roles.revision,
      workerNativeId: CHILD,
    };
    expect(verifiedWorkerForCaller(roles, review, EVENT_AT, CHILD)).toEqual(proof);
    expect(verifiedWorkerForCaller(roles, undefined, EVENT_AT, CHILD)).toBeNull();
    expect(verifiedWorkerForCaller(roles, review, SLOT_AT, CHILD)).toBeNull();
    expect(verifiedWorkerForCaller(roles, review, NEXT_SLOT_AT, CHILD)).toBeNull();
    expect(verifiedWorkerForCaller(roles, { ...review, hash: "bad" }, EVENT_AT, CHILD)).toBeNull();
    expect(
      verifiedWorkerForCaller(
        roles,
        { ...review, actor: { nativeId: ART, role: ART_ROLE } },
        EVENT_AT,
        CHILD,
      ),
    ).toBeNull();
    expect(
      verifiedWorkerForCaller(roles, reviewed(roles, [{ role: ART_ROLE }]), EVENT_AT, CHILD),
    ).toBeNull();

    const changed = { ...roles, revision: roles.revision + 1 };
    const held = {
      ...roles,
      roles: { ...roles.roles, [ART_ROLE]: { ...roles.roles[ART_ROLE]!, phase: "held" } },
    };
    expect(verifiedWorkerForCaller(changed, review, EVENT_AT, CHILD)).toBeNull();
    expect(verifiedWorkerForCaller(held, review, EVENT_AT, CHILD)).toBeNull();
    expect(
      verifiedWorkerForCaller(roles, reviewed(roles, [worker(ART_ROLE, OTHER)]), EVENT_AT, CHILD),
    ).toBeNull();
    expect(
      verifiedWorkerForCaller(roles, reviewed(roles, [worker(TECH_ROLE, TECH)]), EVENT_AT, CHILD),
    ).toBeNull();
    expect(
      verifiedWorkerForCaller(
        roles,
        reviewed(roles, [worker(ART_ROLE, ART), worker(TECH_ROLE, TECH)]),
        EVENT_AT,
        CHILD,
      ),
    ).toBeNull();
  });

  it("attributes only the exact child actor in events written after the review", () => {
    const roles = registry();
    const review = reviewed(roles);
    const actor = resolveCaller(roles, { CODEX_THREAD_ID: CHILD }, {}, (nativeId) =>
      verifiedWorkerForCaller(roles, review, EVENT_AT, nativeId),
    );
    const event = {
      ...review,
      actor,
      at: EVENT_AT,
      kind: "work.started",
      seq: review.seq + 1,
    };
    expect(verifiedWorkerForEvent(roles, review, event, ART_ROLE)).toMatchObject({
      evidenceSha256: review.hash,
      parentNativeId: ART,
      workerNativeId: CHILD,
    });
    expect(verifiedWorkerForEvent(roles, review, event, TECH_ROLE)).toBeNull();
    expect(
      verifiedWorkerForEvent(roles, review, { ...event, seq: review.seq }, ART_ROLE),
    ).toBeNull();
    expect(
      verifiedWorkerForEvent(
        roles,
        review,
        {
          ...event,
          actor: resolveCaller(roles, { CODEX_THREAD_ID: ART }, { worker: CHILD }),
        },
        ART_ROLE,
      ),
    ).toBeNull();
  });
});
