import type { SQLInputValue } from "node:sqlite";

import type { Store } from "./db.ts";
import { secretShape } from "./secrets.ts";
import { type Actor, ROLE, StoreError, type WorkRef } from "./types.ts";
import { checkRef } from "./work.ts";

const ISSUER = "game-coordinator";
const POLICY_ID = /^policy-[a-z0-9][a-z0-9-]{0,120}$/;
const TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/;

type Row = Record<string, SQLInputValue>;
type Reader = Pick<Store, "db">;

export type HoldState = "active" | "released";
export const HOLD_STATES: readonly HoldState[] = ["active", "released"];

export interface HoldView {
  readonly id: string;
  /** The owner; null for an imported hold whose ledger names no registered owner. */
  readonly role: string | null;
  /**
   * `work:<id>`, `role` (the owner itself) or `game:<id>`. An imported hold is `work:` and its
   * `<repository>:<id>` items joined by `,`.
   */
  readonly scope: string;
  /** `approval-ledger` for an imported hold, `user-policy` for a policy hold, else null. */
  readonly source: string | null;
  readonly policy?: PolicyHoldView["policy"];
  readonly reason: string;
  readonly state: HoldState;
  readonly setAt: string;
  readonly releasedAt: string | null;
}

export type PolicyHoldTarget =
  | { readonly kind: "role"; readonly role: string }
  | { readonly kind: "game"; readonly game: string }
  | ({ readonly kind: "work" } & WorkRef);

export interface PolicyHoldView extends HoldView {
  readonly source: "user-policy";
  readonly policy: {
    readonly issuer: typeof ISSUER;
    readonly target: PolicyHoldTarget;
    readonly approval: string;
    readonly releaseApproval: string | null;
  };
}

export interface PolicyHoldInput {
  readonly approval: string;
  readonly id: string;
  readonly reason: string;
  readonly scope: string;
}

function requireIssuer(actor: Actor): void {
  if (actor.role !== ISSUER || actor.nativeId === null || actor.worker !== undefined) {
    throw new StoreError("not-coordinator");
  }
}

function requireId(id: string): void {
  if (!POLICY_ID.test(id)) {
    throw new StoreError("invalid-policy-id");
  }
}

function policyText(value: string, code: string): string {
  if (value.trim() === "" || value.length > 1000 || /[\r\n]/.test(value)) {
    throw new StoreError(code);
  }
  if (secretShape(value) !== null) {
    throw new StoreError("secret-shaped-body");
  }
  return value;
}

export function policyHoldTarget(scope: string): PolicyHoldTarget {
  const [kind, value, id, ...rest] = scope.split(":");
  if (value !== undefined && id === undefined) {
    if (kind === "role" && ROLE.test(value)) {
      return { kind, role: value };
    }
    if (kind === "game" && TOKEN.test(value)) {
      return { game: value, kind };
    }
  }
  if (kind === "work" && value !== undefined && id !== undefined && rest.length === 0) {
    return { ...checkRef({ id, repository: value }), kind };
  }
  throw new StoreError("invalid-policy-scope");
}

/** A work-only policy hold has no effect on a role's inbox wake or session count. */
export function policyTargetCoversRole(target: PolicyHoldTarget, role: string): boolean {
  return (
    (target.kind === "role" && target.role === role) ||
    (target.kind === "game" && role.startsWith(`${target.game}/`))
  );
}

function policyView(row: Row): PolicyHoldView {
  const scope = row.scope as string;
  const target = policyHoldTarget(scope);
  return {
    id: row.id as string,
    policy: {
      approval: row.approval as string,
      issuer: row.issuer as typeof ISSUER,
      releaseApproval: (row.release_approval as string | null) ?? null,
      target,
    },
    reason: row.reason as string,
    releasedAt: (row.released_at as string | null) ?? null,
    role: target.kind === "role" ? target.role : null,
    scope,
    setAt: row.set_at as string,
    source: "user-policy",
    state: row.state as HoldState,
  };
}

function policyRow(store: Reader, id: string): Row | undefined {
  return store.db.prepare("SELECT * FROM policy_holds WHERE id = ?").get(id) as Row | undefined;
}

export function policyHoldIdExists(store: Reader, id: string): boolean {
  return POLICY_ID.test(id) && policyRow(store, id) !== undefined;
}

export function setPolicyHold(
  store: Store,
  actor: Actor,
  input: PolicyHoldInput,
): { readonly duplicate: boolean; readonly hold: PolicyHoldView } {
  requireIssuer(actor);
  const { id, scope } = input;
  requireId(id);
  policyHoldTarget(scope);
  const approval = policyText(input.approval, "invalid-approval");
  const reason = policyText(input.reason, "invalid-reason");
  return store.transaction(() => {
    const existing = policyRow(store, id);
    if (existing !== undefined) {
      if (
        existing.state !== "active" ||
        existing.scope !== scope ||
        existing.reason !== reason ||
        existing.approval !== approval
      ) {
        throw new StoreError("id-conflict");
      }
      return { duplicate: true, hold: policyView(existing) };
    }
    if (store.db.prepare("SELECT 1 FROM holds WHERE id = ?").get(id) !== undefined) {
      throw new StoreError("id-conflict");
    }
    store.append({
      actor,
      key: `hold.policy-set:${id}`,
      kind: "hold.policy-set",
      payload: { approval, id, issuer: ISSUER, reason, scope },
    });
    return { duplicate: false, hold: policyView(policyRow(store, id)!) };
  });
}

export function releasePolicyHold(
  store: Store,
  actor: Actor,
  input: { readonly id: string; readonly approval: string },
): { readonly duplicate: boolean; readonly hold: PolicyHoldView } {
  requireIssuer(actor);
  const { id } = input;
  requireId(id);
  const approval = policyText(input.approval, "invalid-approval");
  return store.transaction(() => {
    const existing = policyRow(store, id);
    if (existing === undefined) {
      throw new StoreError("missing");
    }
    if (existing.state === "released") {
      if (existing.release_approval !== approval) {
        throw new StoreError("id-conflict");
      }
      return { duplicate: true, hold: policyView(existing) };
    }
    store.append({
      actor,
      key: `hold.policy-released:${id}`,
      kind: "hold.policy-released",
      payload: { approval, id, issuer: ISSUER },
    });
    return { duplicate: false, hold: policyView(policyRow(store, id)!) };
  });
}

/** Preserve legacy read-only status before a writer has added the policy projection. */
export function policyHoldEntries(
  store: Reader,
  states: readonly HoldState[],
): { readonly hold: PolicyHoldView; readonly seq: number }[] {
  const exists = store.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'policy_holds'")
    .get();
  if (exists === undefined) {
    return [];
  }
  return (
    store.db
      .prepare(
        `SELECT * FROM policy_holds WHERE state IN (${states.map(() => "?").join(",")})
                ORDER BY set_seq`,
      )
      .all(...states) as Row[]
  ).map((row) => ({ hold: policyView(row), seq: Number(row.set_seq) }));
}

export function activePolicyHoldsForRole(store: Reader, role: string): number {
  const split = role.indexOf("/");
  return Number(
    (
      store.db
        .prepare(
          "SELECT count(*) AS n FROM policy_holds WHERE state = 'active' AND scope IN (?, ?)",
        )
        .get(`role:${role}`, split === -1 ? "" : `game:${role.slice(0, split)}`) as Row
    ).n,
  );
}
