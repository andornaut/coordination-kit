// Sessions and harness handoffs over the store. `session.started` records a role's startup or
// resume; a handoff record carries a scope of roles from one harness to the other through
// preparing, prepared, sent and completed, or cancelled from any open state. A role marks itself
// ready from its source binding, which sets a role-scope hold so wakes are withheld while it sits
// idle, and active from its target binding, which releases that hold. Every writer trusts its
// `actor`; the service resolves it through the registry fence and checks the role first.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { Harness } from "../registry/schema.ts";
import type { Store } from "./db.ts";
import type { Projection } from "./projections.ts";
import { type HoldView, listHolds } from "./questions.ts";
import { type Actor, type JsonObject, type StoredEvent, StoreError } from "./types.ts";

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

export const HANDOFF_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

type Row = Record<string, SQLInputValue>;

function ensure(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new StoreError(code);
  }
}

function text(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/** The hold `handoff ready` sets for a role: `/` in a game role is written as `-`. */
export function handoffHoldId(id: string, role: string): string {
  return `handoff-${id}-${role.replaceAll("/", "-")}`;
}

const HANDOFFS_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  role TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  version TEXT NOT NULL,
  cwd TEXT NOT NULL,
  started_at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  from_harness TEXT NOT NULL,
  to_harness TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('preparing', 'prepared', 'sent', 'completed', 'cancelled')),
  opened_at TEXT NOT NULL,
  opened_seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoff_roles (
  handoff TEXT NOT NULL,
  role TEXT NOT NULL,
  from_harness TEXT NOT NULL,
  ready_at TEXT,
  active_at TEXT,
  PRIMARY KEY (handoff, role)
);
`;

const sessionStarted = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare(
    `INSERT OR REPLACE INTO sessions (role, harness, native_id, version, cwd, started_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    text(p, "role"),
    text(p, "harness"),
    text(p, "nativeId"),
    text(p, "version"),
    text(p, "cwd"),
    event.at,
    event.seq,
  );
};

const opened = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  const roles = (Array.isArray(p.roles) ? (p.roles as readonly JsonObject[]) : []).map((item) => ({
    from: text(item, "from"),
    role: text(item, "role"),
  }));
  db.prepare(
    `INSERT INTO handoffs (id, scope, from_harness, to_harness, state, opened_at, opened_seq,
       updated_at) VALUES (?, ?, ?, ?, 'preparing', ?, ?, ?)`,
  ).run(
    text(p, "id"),
    JSON.stringify(roles.map((item) => item.role)),
    text(p, "from"),
    text(p, "to"),
    event.at,
    event.seq,
    event.at,
  );
  const insert = db.prepare(
    "INSERT INTO handoff_roles (handoff, role, from_harness) VALUES (?, ?, ?)",
  );
  for (const item of roles) {
    insert.run(text(p, "id"), item.role, item.from);
  }
};

const roleMark =
  (column: "ready_at" | "active_at") =>
  (db: DatabaseSync, event: StoredEvent): void => {
    const p = event.payload;
    db.prepare(`UPDATE handoff_roles SET ${column} = ? WHERE handoff = ? AND role = ?`).run(
      event.at,
      text(p, "id"),
      text(p, "role"),
    );
    db.prepare("UPDATE handoffs SET updated_at = ? WHERE id = ?").run(event.at, text(p, "id"));
  };

const stateSet = (db: DatabaseSync, event: StoredEvent): void => {
  const p = event.payload;
  db.prepare("UPDATE handoffs SET state = ?, updated_at = ? WHERE id = ?").run(
    text(p, "state"),
    event.at,
    text(p, "id"),
  );
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
  ddl: HANDOFFS_DDL,
  tables: ["sessions", "handoffs", "handoff_roles"],
};

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

function view(store: Store, row: Row): HandoffView {
  const id = row.id as string;
  const roles = (
    store.db.prepare("SELECT * FROM handoff_roles WHERE handoff = ? ORDER BY role").all(id) as Row[]
  ).map((item) => ({
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

function handoffRow(store: Store, id: string): Row | undefined {
  return store.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Row | undefined;
}

export function readHandoff(store: Store, id: string): HandoffView | null {
  const row = handoffRow(store, id);
  return row === undefined ? null : view(store, row);
}

/** The latest handoff by opening order, or null. */
export function latestHandoff(store: Store): HandoffView | null {
  const row = store.db.prepare("SELECT * FROM handoffs ORDER BY opened_seq DESC LIMIT 1").get() as
    Row | undefined;
  return row === undefined ? null : view(store, row);
}

/** The open handoffs whose scope includes `role`, in opening order. */
export function openHandoffsFor(store: Store, role: string): HandoffView[] {
  return (
    store.db
      .prepare(
        `SELECT h.* FROM handoffs h JOIN handoff_roles r ON r.handoff = h.id
         WHERE r.role = ? AND h.state IN ('preparing', 'prepared', 'sent') ORDER BY h.opened_seq`,
      )
      .all(role) as Row[]
  ).map((row) => view(store, row));
}

/** The handoff holds of a record, active and released. */
export function handoffHolds(store: Store, handoff: HandoffView): HoldView[] {
  const ids = new Set(handoff.roles.map((item) => item.hold));
  return listHolds(store).filter((hold) => ids.has(hold.id));
}

function nextId(store: Store): string {
  const rows = store.db.prepare("SELECT id FROM handoffs").all() as Row[];
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
  const row = store.db.prepare("SELECT state FROM holds WHERE id = ?").get(hold) as Row | undefined;
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
