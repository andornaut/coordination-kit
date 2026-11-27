import type { Layout } from "../../core/configuration/layout.ts";
import { isPermitted } from "../../registry/permissions.ts";
import type { Registry } from "../../registry/schema.ts";
import type { Store } from "../db.ts";
import type { ProjectionRow } from "../projectionIndex.ts";
import { secretShape } from "../secrets.ts";
import { requirePermission } from "../sessions/permissions.ts";
import { type Actor, ROLE, StoreError, type WorkRef } from "../types.ts";
import { checkRef } from "../work-records/work.ts";

const POLICY_ID = /^policy-[a-z0-9][a-z0-9-]{0,120}$/;
const TOKEN = /^[a-z0-9][a-z0-9-]{0,63}$/;

type Row = ProjectionRow;
type Reader = Pick<Store, "index">;

export type HoldState = "active" | "released";
export const HOLD_STATES: readonly HoldState[] = ["active", "released"];

export interface HoldView {
  readonly id: string;
  /** The owner; null for an imported hold whose ledger names no registered owner. */
  readonly role: string | null;
  /**
   * `work:<id>`, `role` (the owner itself) or `app:<id>`. An imported hold is `work:` and its
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
  | { readonly kind: "app"; readonly app: string }
  | { readonly kind: "game"; readonly game: string }
  | ({ readonly kind: "work" } & WorkRef);

export interface PolicyHoldView extends HoldView {
  readonly source: "user-policy";
  readonly policy: {
    readonly issuer: string;
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

export interface PolicyHoldAuthority {
  readonly layout: Layout;
  readonly registry: Registry;
}

export function requirePolicyIssuer(authority: PolicyHoldAuthority, actor: Actor): void {
  const { layout, registry } = authority;
  if (
    !Object.keys(layout.config.apps).some((app) =>
      isPermitted(layout, registry, actor, "policy:manage", app),
    )
  ) {
    requirePermission(layout, registry, actor, "policy:manage");
  }
}

function requireTargetPermission(
  authority: PolicyHoldAuthority,
  actor: Actor,
  target: PolicyHoldTarget,
): void {
  const { layout, registry } = authority;
  const app =
    target.kind === "app"
      ? target.app
      : target.kind === "game"
        ? target.game
        : target.kind === "work"
          ? target.repository
          : undefined;
  requirePermission(
    layout,
    registry,
    actor,
    "policy:manage",
    app !== undefined && Object.hasOwn(layout.config.apps, app) ? app : undefined,
  );
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
    if (kind === "app" && TOKEN.test(value)) {
      return { app: value, kind };
    }
  }
  if (kind === "work" && value !== undefined && id !== undefined && rest.length === 0) {
    return { ...checkRef({ id, repository: value }), kind };
  }
  throw new StoreError("invalid-policy-scope");
}

function storedPolicyHoldTarget(scope: string): PolicyHoldTarget {
  const [kind, value, ...rest] = scope.split(":");
  if (kind === "game" && value !== undefined && TOKEN.test(value) && rest.length === 0) {
    return { game: value, kind };
  }
  return policyHoldTarget(scope);
}

/** A work-only policy hold has no effect on a role's inbox wake or session count. */
export function policyTargetCoversRole(
  target: PolicyHoldTarget,
  role: string,
  layout?: Layout,
): boolean {
  if (target.kind === "app") {
    return layout?.config.apps[target.app]?.roles.includes(role) === true;
  }
  return (
    (target.kind === "role" && target.role === role) ||
    (target.kind === "game" &&
      (layout === undefined
        ? role.startsWith(`${target.game}/`)
        : layout.config.apps[target.game]?.roles.includes(role) === true))
  );
}

function policyView(row: Row): PolicyHoldView {
  const scope = row.scope as string;
  const target = storedPolicyHoldTarget(scope);
  return {
    id: row.id as string,
    policy: {
      approval: row.approval as string,
      issuer: row.issuer as string,
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
  return store.index.get("policy_holds", [id]);
}

export function policyHoldIdExists(store: Reader, id: string): boolean {
  return POLICY_ID.test(id) && policyRow(store, id) !== undefined;
}

export function setPolicyHold(
  store: Store,
  authority: PolicyHoldAuthority,
  actor: Actor,
  input: PolicyHoldInput,
): { readonly duplicate: boolean; readonly hold: PolicyHoldView } {
  const { id, scope } = input;
  const target = policyHoldTarget(scope);
  requireTargetPermission(authority, actor, target);
  if (target.kind === "app" && !Object.hasOwn(authority.layout.config.apps, target.app)) {
    throw new StoreError("policy-app-unregistered");
  }
  requireId(id);
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
    if (store.index.get("holds", [id]) !== undefined) {
      throw new StoreError("id-conflict");
    }
    store.append({
      actor,
      key: `hold.policy-set:${id}`,
      kind: "hold.policy-set",
      payload: { approval, id, issuer: actor.role, reason, scope },
    });
    return { duplicate: false, hold: policyView(policyRow(store, id)!) };
  });
}

export function releasePolicyHold(
  store: Store,
  authority: PolicyHoldAuthority,
  actor: Actor,
  input: { readonly id: string; readonly approval: string },
): { readonly duplicate: boolean; readonly hold: PolicyHoldView } {
  requirePolicyIssuer(authority, actor);
  const { id } = input;
  requireId(id);
  const approval = policyText(input.approval, "invalid-approval");
  return store.transaction(() => {
    const existing = policyRow(store, id);
    if (existing === undefined) {
      throw new StoreError("missing");
    }
    requireTargetPermission(authority, actor, storedPolicyHoldTarget(existing.scope as string));
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
      payload: { approval, id, issuer: actor.role },
    });
    return { duplicate: false, hold: policyView(policyRow(store, id)!) };
  });
}

/** Policy holds in setting order. */
export function policyHoldEntries(
  store: Reader,
  states: readonly HoldState[],
): { readonly hold: PolicyHoldView; readonly seq: number }[] {
  return store.index
    .rows("policy_holds")
    .filter((row) => states.includes(row.state as HoldState))
    .sort((a, b) => Number(a.set_seq) - Number(b.set_seq))
    .map((row) => ({ hold: policyView(row), seq: Number(row.set_seq) }));
}

export function activePolicyHoldsForRole(store: Reader, role: string, layout?: Layout): number {
  return policyHoldEntries(store, ["active"]).filter(({ hold }) =>
    policyTargetCoversRole(hold.policy.target, role, layout),
  ).length;
}
