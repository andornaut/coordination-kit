// The latest session per role and the handoff records with their per-role times.
import { payloadText as text } from "../eventCodec.ts";
import type { ProjectionIndex } from "../projectionIndex.ts";
import type { JsonObject, Projection, StoredEvent } from "../types.ts";

/** The hold `handoff ready` sets for a role: `/` in a game role is written as `-`. */
export function handoffHoldId(id: string, role: string): string {
  return `handoff-${id}-${role.replaceAll("/", "-")}`;
}

const sessionStarted = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const role = text(p, "role");
  index.put("sessions", [role], {
    cwd: text(p, "cwd"),
    harness: text(p, "harness"),
    native_id: text(p, "nativeId"),
    role,
    seq: event.seq,
    started_at: event.at,
    version: text(p, "version"),
  });
};

const opened = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const id = text(p, "id");
  const roles = (Array.isArray(p.roles) ? (p.roles as readonly JsonObject[]) : []).map((item) => ({
    from: text(item, "from"),
    role: text(item, "role"),
  }));
  index.put("handoffs", [id], {
    from_harness: text(p, "from"),
    id,
    opened_at: event.at,
    opened_seq: event.seq,
    scope: JSON.stringify(roles.map((item) => item.role)),
    state: "preparing",
    to_harness: text(p, "to"),
    updated_at: event.at,
  });
  for (const item of roles) {
    index.put("handoff_roles", [id, item.role], {
      active_at: null,
      from_harness: item.from,
      handoff: id,
      ready_at: null,
      role: item.role,
    });
  }
};

const roleMark =
  (column: "ready_at" | "active_at") =>
  (index: ProjectionIndex, event: StoredEvent): void => {
    const p = event.payload;
    const id = text(p, "id");
    const key = [id, text(p, "role")];
    const role = index.get("handoff_roles", key);
    if (role !== undefined) {
      index.put("handoff_roles", key, { ...role, [column]: event.at });
    }
    const handoff = index.get("handoffs", [id]);
    if (handoff !== undefined) {
      index.put("handoffs", [id], { ...handoff, updated_at: event.at });
    }
  };

const stateSet = (index: ProjectionIndex, event: StoredEvent): void => {
  const p = event.payload;
  const id = text(p, "id");
  const handoff = index.get("handoffs", [id]);
  if (handoff !== undefined) {
    index.put("handoffs", [id], { ...handoff, state: text(p, "state"), updated_at: event.at });
  }
};

/** The latest session per role and the handoff records with their per-role times. */
export const HANDOFFS_PROJECTION: Projection = {
  apply: {
    "handoff.active": roleMark("active_at"),
    "handoff.opened": opened,
    "handoff.ready": roleMark("ready_at"),
    "handoff.state": stateSet,
    "session.started": sessionStarted,
  },
  tables: ["sessions", "handoffs", "handoff_roles"],
};
