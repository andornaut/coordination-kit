// Replay user-approved policy holds with their original issuer. Live grants can change over time.
import { payloadText as text } from "../eventCodec.ts";
import { ensure, type Projection, ROLE, type StoredEvent } from "../types.ts";

export function recordedPolicyIssuer(event: StoredEvent): string | null {
  const issuer = event.payload.issuer;
  return typeof issuer === "string" &&
    ROLE.test(issuer) &&
    event.actor.role === issuer &&
    event.actor.nativeId !== null &&
    event.actor.worker === undefined
    ? issuer
    : null;
}

export const POLICY_HOLDS_PROJECTION: Projection = {
  apply: {
    "hold.policy-released": (index, event) => {
      const id = text(event.payload, "id");
      ensure(recordedPolicyIssuer(event) !== null, "policy-issuer-unverified");
      const previous = index.get("policy_holds", [id]);
      if (previous !== undefined) {
        index.put("policy_holds", [id], {
          ...previous,
          release_approval: text(event.payload, "approval"),
          released_at: event.at,
          state: "released",
        });
      }
    },
    "hold.policy-set": (index, event) => {
      const p = event.payload;
      const id = text(p, "id");
      const issuer = recordedPolicyIssuer(event);
      ensure(issuer !== null, "policy-issuer-unverified");
      ensure(index.get("policy_holds", [id]) === undefined, "duplicate-policy-hold");
      index.put("policy_holds", [id], {
        approval: text(p, "approval"),
        id,
        issuer,
        reason: text(p, "reason"),
        release_approval: null,
        released_at: null,
        scope: text(p, "scope"),
        set_at: event.at,
        set_seq: event.seq,
        state: "active",
      });
    },
  },
  tables: ["policy_holds"],
};
