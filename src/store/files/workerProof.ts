import { isCanonicalUuid } from "../../core/ids.ts";
import { isRecord } from "../../core/pyjson.ts";
import type { Registry } from "../../registry/schema.ts";
import {
  DELIVERY_KIT_ROLE,
  matchesVerifiedWorker,
  type VerifiedWorkerCaller,
} from "../identity.ts";
import type { StoredEvent } from "../types.ts";

const REVIEW_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Match the latest genuine review from the trusted journal. A new review without exact lineage,
 * a missed slot or a different registry revision leaves the claim unverified.
 */
export function verifiedWorkerForCaller(
  registry: Registry,
  latestReview: StoredEvent | undefined,
  at: string,
  nativeId: string,
): VerifiedWorkerCaller | null {
  if (
    !isCanonicalUuid(nativeId) ||
    latestReview?.kind !== "review.brief" ||
    latestReview.actor.role !== DELIVERY_KIT_ROLE ||
    latestReview.actor.nativeId !== null ||
    latestReview.actor.worker !== undefined
  ) {
    return null;
  }
  const { native, result, slot } = latestReview.payload;
  if (
    !isRecord(native) ||
    native.registryRevision !== registry.revision ||
    !Array.isArray(native.workers) ||
    !isRecord(result) ||
    result.status !== "delivered" ||
    typeof slot !== "number" ||
    !Number.isSafeInteger(slot)
  ) {
    return null;
  }
  const reviewAt = Date.parse(latestReview.at);
  const slotAt = slot * 1000;
  const callerAt = Date.parse(at);
  if (!(slotAt <= reviewAt && reviewAt <= callerAt && callerAt < slotAt + REVIEW_INTERVAL_MS)) {
    return null;
  }
  const matches = (native.workers as readonly unknown[]).flatMap((worker) => {
    if (
      !isRecord(worker) ||
      typeof worker.role !== "string" ||
      !isRecord(worker.lineage) ||
      !isCanonicalUuid(worker.lineage.parentNativeId) ||
      !Array.isArray(worker.lineage.workerNativeIds) ||
      !worker.lineage.workerNativeIds.includes(nativeId)
    ) {
      return [];
    }
    return [
      {
        evidenceSha256: latestReview.hash,
        parentNativeId: worker.lineage.parentNativeId,
        parentRole: worker.role,
        registryRevision: registry.revision,
        workerNativeId: nativeId,
      },
    ];
  });
  const [proof] = matches;
  return matches.length === 1 &&
    proof !== undefined &&
    matchesVerifiedWorker(registry, nativeId, proof)
    ? proof
    : null;
}

/**
 * Attribute an event only when its authenticated actor is the proved child. The latest
 * applicable review must precede the event in the journal. Labels are never evidence.
 */
export function verifiedWorkerForEvent(
  registry: Registry,
  latestReview: StoredEvent | undefined,
  event: StoredEvent,
  parentRole: string,
): VerifiedWorkerCaller | null {
  if (
    event.actor.role !== parentRole ||
    !isCanonicalUuid(event.actor.nativeId) ||
    latestReview === undefined ||
    latestReview.seq >= event.seq
  ) {
    return null;
  }
  const proof = verifiedWorkerForCaller(registry, latestReview, event.at, event.actor.nativeId);
  return proof?.parentRole === parentRole ? proof : null;
}
