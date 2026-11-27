// Each message's wake attempts and their safe blockers. Blocker and reason text is validated
// before it is stored or printed, so nothing private reaches the projection.
import type { ProjectionIndex } from "../projectionIndex.ts";
import { secretShape } from "../secrets.ts";
import {
  type JsonObject,
  type Projection,
  ROLE,
  type StoredEvent,
  type WakeBlocker,
} from "../types.ts";

const CODE = /^[a-z][a-z0-9-]{0,95}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const BLOCKER_KINDS = ["question", "hold", "policy-hold", "registry", "wake", "native-question"];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function safeWakeReason(input: unknown, fallback: string): string {
  return typeof input === "string" && CODE.test(input) && secretShape(input) === null
    ? input
    : fallback;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value) && secretShape(value) === null;
}

export function safeWakeBlocker(
  input: unknown,
  owner: string,
  policyIssuer?: string,
): WakeBlocker | null {
  const value = record(input);
  const blockerOwner = value?.kind === "policy-hold" ? policyIssuer : owner;
  if (
    value === null ||
    value.owner !== blockerOwner ||
    typeof blockerOwner !== "string" ||
    !ROLE.test(blockerOwner) ||
    secretShape(blockerOwner) !== null ||
    !ROLE.test(owner) ||
    typeof value.kind !== "string" ||
    !BLOCKER_KINDS.includes(value.kind) ||
    !safeId(value.id)
  ) {
    return null;
  }
  const native = record(value.native);
  const reference =
    (value.kind === "question" || value.kind === "native-question") &&
    safeId(native?.turnId) &&
    safeId(native.itemId)
      ? { itemId: native.itemId, turnId: native.turnId }
      : null;
  if (value.kind === "native-question" && reference === null) {
    return null;
  }
  return {
    id: value.id,
    kind: value.kind as WakeBlocker["kind"],
    owner: blockerOwner,
    ...(reference === null ? {} : { native: reference }),
  };
}

export function storedWakeBlocker(
  index: ProjectionIndex,
  input: unknown,
  owner: string,
): WakeBlocker | null {
  const value = record(input);
  const issuer =
    value?.kind === "policy-hold" && safeId(value.id)
      ? index.get("policy_holds", [value.id])?.issuer
      : undefined;
  return safeWakeBlocker(input, owner, typeof issuer === "string" ? issuer : undefined);
}

function exactMessages(index: ProjectionIndex, event: StoredEvent): void {
  const { blocker, messages, role, wake } = event.payload;
  if (!Array.isArray(messages) || typeof role !== "string" || typeof wake !== "string") {
    return;
  }
  const safe = storedWakeBlocker(index, blocker, role);
  for (const id of messages) {
    if (typeof id !== "string" || index.get("messages", [id])?.to_role !== role) {
      continue;
    }
    const key = [id, wake];
    if (index.get("message_wakes", key) === undefined) {
      index.put("message_wakes", key, {
        blocker: encode(safe),
        coalesced: event.kind === "wake.coalesced" ? 1 : 0,
        message_id: id,
        seq: event.seq,
        wake_id: wake,
      });
    }
  }
}

function encode(value: WakeBlocker | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

export function blockerPayload(value: WakeBlocker | null): JsonObject | null {
  return value === null ? null : { ...value };
}

export const MESSAGE_WAKE_PROJECTION: Projection = {
  apply: {
    "wake.claimed": exactMessages,
    "wake.coalesced": exactMessages,
    "wake.completed": (index, event) => {
      const { blocker, role, wake } = event.payload;
      if (typeof role === "string" && typeof wake === "string") {
        const safe = encode(storedWakeBlocker(index, blocker, role));
        for (const row of index.rows("message_wakes")) {
          if (row.wake_id === wake && row.coalesced === 0) {
            index.put("message_wakes", [row.message_id!, wake], { ...row, blocker: safe });
          }
        }
      }
    },
    "wake.guarded": exactMessages,
  },
  tables: ["message_wakes"],
};
