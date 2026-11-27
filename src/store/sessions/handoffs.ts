// Sessions and harness handoffs over the store. `session.started` records a role's startup or
// resume; a handoff record carries a scope of roles from one harness to the other through
// preparing, prepared, sent and completed, or cancelled from any open state. A role marks itself
// ready from its source binding, which sets a role-scope hold so wakes are withheld while it sits
// idle, and active from its target binding, which releases that hold. Every writer trusts its
// `actor`; the service resolves it through the registry fence and checks the role first.
import type { Harness } from "../../registry/schema.ts";
import type { Store } from "../db.ts";
import type { HoldView } from "../decisions/policyHolds.ts";
import { listHolds } from "../decisions/questions.ts";
import type { ProjectionRow } from "../projectionIndex.ts";
import { handoffHoldId } from "../projections/handoffs.ts";
import { type Actor, ensure, type StoredEvent } from "../types.ts";

export type HandoffState = "preparing" | "prepared" | "sent" | "completed" | "cancelled";
export const HANDOFF_STATES: readonly HandoffState[] = [
  "preparing",
  "prepared",
  "sent",
  "completed",
  "cancelled",
];
export const OPEN_HANDOFF_STATES: readonly HandoffState[] = ["preparing", "prepared", "sent"];

/** Each state `handoff state` may set, from the state it requires. Cancelled is from any open one. */
export const HANDOFF_TRANSITIONS: Readonly<Record<string, readonly HandoffState[]>> = {
  cancelled: OPEN_HANDOFF_STATES,
  completed: ["sent"],
  prepared: ["preparing"],
  sent: ["prepared"],
};

const HANDOFF_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface HandoffRoleView {
  readonly role: string;
  readonly from: Harness;
  readonly readyAt: string | null;
  readonly activeAt: string | null;
  /** The role-scope hold `handoff ready` sets. */
  readonly hold: string;
}

export interface HandoffView {
  readonly id: string;
  readonly scope: readonly string[];
  readonly from: Harness;
  readonly to: Harness;
  readonly state: HandoffState;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly roles: readonly HandoffRoleView[];
}

export interface HandoffResult {
  readonly handoff: HandoffView;
  readonly duplicate: boolean;
}

export function recordSession(
  store: Store,
  actor: Actor & { readonly role: string; readonly nativeId: string },
  input: {
    readonly key: string;
    readonly harness: Harness;
    readonly version: string;
    readonly cwd: string;
  },
): StoredEvent {
  return store.append({
    actor,
    key: `session.started:${input.key}`,
    kind: "session.started",
    payload: {
      cwd: input.cwd,
      harness: input.harness,
      nativeId: actor.nativeId,
      role: actor.role,
      version: input.version,
    },
  }).event;
}

function view(store: Store, row: ProjectionRow): HandoffView {
  const id = row.id as string;
  const roles = store.index
    .rows("handoff_roles")
    .filter((item) => item.handoff === id)
    .sort((a, b) =>
      String(a.role) < String(b.role) ? -1 : String(a.role) > String(b.role) ? 1 : 0,
    )
    .map((item) => ({
      activeAt: (item.active_at as string | null) ?? null,
      from: item.from_harness as Harness,
      hold: handoffHoldId(id, item.role as string),
      readyAt: (item.ready_at as string | null) ?? null,
      role: item.role as string,
    }));
  return {
    from: row.from_harness as Harness,
    id,
    openedAt: row.opened_at as string,
    roles,
    scope: JSON.parse(row.scope as string) as string[],
    state: row.state as HandoffState,
    to: row.to_harness as Harness,
    updatedAt: row.updated_at as string,
  };
}

export function readHandoff(store: Store, id: string): HandoffView | null {
  const row = store.index.get("handoffs", [id]);
  return row === undefined ? null : view(store, row);
}

/** The latest handoff by opening order, or null. */
export function latestHandoff(store: Store): HandoffView | null {
  const row = store.index
    .rows("handoffs")
    .toSorted((a, b) => Number(b.opened_seq) - Number(a.opened_seq))[0];
  return row === undefined ? null : view(store, row);
}

/** The open handoffs whose scope includes `role`, in opening order. */
export function openHandoffsFor(store: Store, role: string): HandoffView[] {
  return store.index
    .rows("handoffs")
    .filter(
      (row) =>
        OPEN_HANDOFF_STATES.includes(row.state as HandoffState) &&
        store.index.get("handoff_roles", [row.id as string, role]) !== undefined,
    )
    .sort((a, b) => Number(a.opened_seq) - Number(b.opened_seq))
    .map((row) => view(store, row));
}

/** The handoff holds of a record, active and released. */
export function handoffHolds(store: Store, handoff: HandoffView): HoldView[] {
  const ids = new Set(handoff.roles.map((item) => item.hold));
  return listHolds(store).filter((hold) => ids.has(hold.id));
}

function nextId(store: Store): string {
  const rows = store.index.rows("handoffs");
  const highest = rows
    .map((row) => /^h-([1-9][0-9]{0,8})$/.exec(row.id as string)?.[1])
    .reduce((top, n) => Math.max(top, n === undefined ? 0 : Number(n)), 0);
  return `h-${highest + 1}`;
}

/**
 * Open a handoff for `roles`, each moving from its current harness to `to`. Repeating it with the
 * same ID, scope and target is a no-op; any other reuse of the ID is `id-conflict`. An open
 * handoff that covers any of the roles is `handoff-conflict`.
 */
export function openHandoff(
  store: Store,
  actor: Actor,
  input: {
    readonly id?: string;
    readonly to: Harness;
    readonly roles: readonly { readonly role: string; readonly from: Harness }[];
  },
): HandoffResult {
  ensure(input.id === undefined || HANDOFF_ID.test(input.id), "invalid-id");
  ensure(input.roles.length > 0, "empty-scope");
  ensure(
    input.roles.every((item) => item.from !== input.to),
    "already-on-target",
  );
  const roles = [...input.roles].sort((a, b) => a.role.localeCompare(b.role));
  return store.transaction(() => {
    if (input.id !== undefined) {
      const existing = readHandoff(store, input.id);
      if (existing !== null) {
        ensure(
          existing.to === input.to &&
            existing.scope.join("\n") === roles.map((item) => item.role).join("\n"),
          "id-conflict",
        );
        return { duplicate: true, handoff: existing };
      }
    }
    ensure(
      roles.every((item) => openHandoffsFor(store, item.role).length === 0),
      "handoff-conflict",
    );
    const id = input.id ?? nextId(store);
    store.append({
      actor,
      key: `handoff.opened:${id}`,
      kind: "handoff.opened",
      payload: {
        from: roles[0]!.from,
        id,
        roles: roles.map((item) => ({ from: item.from, role: item.role })),
        to: input.to,
      },
    });
    return { duplicate: false, handoff: readHandoff(store, id)! };
  });
}

/** The caller's open handoff: the named one, which must include it, or the one covering it. */
function ownHandoff(store: Store, role: string, id: string | undefined): HandoffView {
  if (id !== undefined) {
    ensure(HANDOFF_ID.test(id), "invalid-id");
    const handoff = readHandoff(store, id);
    ensure(handoff !== null, "handoff-missing");
    ensure(
      handoff.roles.some((item) => item.role === role),
      "not-in-handoff",
    );
    return handoff;
  }
  const [handoff] = openHandoffsFor(store, role);
  ensure(handoff !== undefined, "not-in-handoff");
  return handoff;
}

/**
 * Mark the caller ready from its source binding while the handoff is preparing, and set its
 * role-scope hold. A repeat is a no-op.
 */
export function readyHandoff(
  store: Store,
  actor: Actor & { readonly role: string },
  input: { readonly id?: string; readonly harness: Harness },
): HandoffResult {
  return store.transaction(() => {
    const handoff = ownHandoff(store, actor.role, input.id);
    const entry = handoff.roles.find((item) => item.role === actor.role)!;
    ensure(input.harness === entry.from, "not-source");
    if (entry.readyAt !== null) {
      return { duplicate: true, handoff };
    }
    ensure(handoff.state === "preparing", "handoff-not-preparing");
    store.append({
      actor,
      key: `handoff.ready:${handoff.id}:${actor.role}`,
      kind: "handoff.ready",
      payload: { hold: entry.hold, id: handoff.id, role: actor.role },
    });
    store.append({
      actor,
      key: `hold.set:${entry.hold}`,
      kind: "hold.set",
      payload: {
        id: entry.hold,
        reason: `handoff ${handoff.id} to ${handoff.to}`,
        role: actor.role,
        scope: "role",
      },
    });
    return { duplicate: false, handoff: readHandoff(store, handoff.id)! };
  });
}

function releaseHandoffHold(store: Store, actor: Actor, handoff: string, hold: string): boolean {
  const row = store.index.get("holds", [hold]);
  if (row?.state !== "active") {
    return false;
  }
  store.append({
    actor,
    key: `hold.released:${hold}`,
    kind: "hold.released",
    payload: { handoff, id: hold },
  });
  return true;
}

/**
 * Mark the caller active from its target binding once the handoff is sent, and release its
 * handoff hold. A repeat is a no-op. Returns whether a hold was released.
 */
export function activeHandoff(
  store: Store,
  actor: Actor & { readonly role: string },
  input: { readonly id?: string; readonly harness: Harness },
): HandoffResult & { readonly released: boolean } {
  return store.transaction(() => {
    const handoff = ownHandoff(store, actor.role, input.id);
    const entry = handoff.roles.find((item) => item.role === actor.role)!;
    ensure(input.harness === handoff.to, "not-target");
    if (entry.activeAt !== null) {
      return { duplicate: true, handoff, released: false };
    }
    ensure(handoff.state === "sent", "handoff-not-sent");
    store.append({
      actor,
      key: `handoff.active:${handoff.id}:${actor.role}`,
      kind: "handoff.active",
      payload: { id: handoff.id, role: actor.role },
    });
    const released = releaseHandoffHold(store, actor, handoff.id, entry.hold);
    return { duplicate: false, handoff: readHandoff(store, handoff.id)!, released };
  });
}

/**
 * Move a handoff to `state` along `HANDOFF_TRANSITIONS`. `prepared` requires every role ready,
 * `completed` every role active, and `cancelled` releases the handoff holds still active. Setting
 * the current state again is a no-op. Returns the roles whose hold was released.
 */
export function setHandoffState(
  store: Store,
  actor: Actor,
  id: string,
  state: HandoffState,
): HandoffResult & { readonly released: readonly string[] } {
  ensure(HANDOFF_ID.test(id), "invalid-id");
  const from = HANDOFF_TRANSITIONS[state];
  ensure(from !== undefined, "invalid-state");
  return store.transaction(() => {
    const handoff = readHandoff(store, id);
    ensure(handoff !== null, "handoff-missing");
    if (handoff.state === state) {
      return { duplicate: true, handoff, released: [] };
    }
    ensure(from.includes(handoff.state), "invalid-transition");
    if (state === "prepared") {
      ensure(
        handoff.roles.every((item) => item.readyAt !== null),
        "handoff-not-ready",
      );
    }
    if (state === "completed") {
      ensure(
        handoff.roles.every((item) => item.activeAt !== null),
        "handoff-not-active",
      );
    }
    store.append({
      actor,
      key: `handoff.state:${id}:${state}`,
      kind: "handoff.state",
      payload: { from: handoff.state, id, state },
    });
    const released =
      state === "cancelled"
        ? handoff.roles
            .filter((item) => releaseHandoffHold(store, actor, id, item.hold))
            .map((item) => item.role)
        : [];
    return { duplicate: false, handoff: readHandoff(store, id)!, released };
  });
}
