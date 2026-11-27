// `session start` and the `handoff` verbs as the CLI runs them. Each writer resolves its caller
// through the registry fence; `handoff open` and `handoff state` also require handoff permission.
// `session start` alone may rebind an unbound Claude caller whose transcript proves a /clear of
// exactly one role's current binding.
// `handoff ready` admits only the role's source binding and `handoff active` only its target
// binding, which `harness select` makes effective. `handoff show` takes no caller.
import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";

import { CONVERSATION_ID_PATTERN } from "../../core/validate.ts";
import { claudeProjectsDir, clearPredecessor } from "../../registry/claudeLineage.ts";
import { resolveConversation, resolveHarness } from "../../registry/resolve.ts";
import type { Harness, Registry } from "../../registry/schema.ts";
import { RevisionConflict, updateRegistry } from "../../registry/store.ts";
import { registry, type StoreServiceContext, withStore } from "../context.ts";
import type { Store } from "../db.ts";
import { activePolicyHoldsForRole, type HoldView } from "../decisions/policyHolds.ts";
import { listQuestions, type QuestionView } from "../decisions/questions.ts";
import { wakeOwner } from "../decisions/questionService.ts";
import { COORDINATOR_ROLE } from "../maintenance/retire.ts";
import type { WakeStatus } from "../messages/wake.ts";
import { type Actor, StoreError } from "../types.ts";
import {
  activeHandoff,
  handoffHolds,
  type HandoffResult,
  type HandoffState,
  type HandoffView,
  latestHandoff,
  openHandoff,
  openHandoffsFor,
  readHandoff,
  readyHandoff,
  recordSession,
  setHandoffState,
} from "./handoffs.ts";
import { type CallerOptions, NATIVE_ID_VARIABLES, resolveCaller } from "./identity.ts";
import { requirePermission } from "./permissions.ts";

/** A refusal that carries a short reason printed after its code. */
class ReasonedStoreError extends StoreError {
  readonly reason: string;

  constructor(code: string, reason: string) {
    super(code, reason);
    this.reason = reason;
  }
}

/** The checkpoint for a role: `games/<game>/<role>`, `kits/<kit>` or `game-coordinator`. */
export function checkpointPath(role: string): string {
  const [game, name] = role.split("/");
  const scope =
    name !== undefined
      ? `games/${game}/${name}`
      : role === COORDINATOR_ROLE
        ? COORDINATOR_ROLE
        : `kits/${role}`;
  return `var/handoffs/${scope}/current.md`;
}

export interface SessionOutput {
  readonly schema: 1;
  readonly role: string;
  readonly harness: Harness;
  readonly conversation: string;
  readonly registry: {
    readonly revision: number;
    readonly phase: string | null;
    readonly ownership: string;
  };
  readonly checkpoint: string;
  readonly counts: { readonly questions: number; readonly holds: number; readonly inbox: number };
  readonly questionRecovery?: {
    readonly pending: readonly QuestionView[];
    readonly unread: number;
  };
  readonly handoffs: readonly {
    readonly id: string;
    readonly state: HandoffState;
    readonly to: Harness;
    readonly readyAt: string | null;
    readonly activeAt: string | null;
  }[];
  readonly session: {
    readonly seq: number;
    readonly at: string;
    readonly version: string;
    readonly cwd: string;
  };
  /** Present only when this start rebound the role after a Claude /clear. */
  readonly rotation?: SessionRotation;
}

interface SessionRotation {
  /** The Claude conversation the role was bound to before the rebind. */
  readonly from: string;
  /** The registry revision the rebind wrote. */
  readonly revision: number;
}

type Caller = ReturnType<typeof resolveCaller>;

/**
 * Rebind the one Claude role whose current binding the caller was cleared from, then resolve the
 * caller again. Requires `refusal` to be `caller-unbound`, no `--native-id` and a valid
 * `CLAUDE_CODE_SESSION_ID` whose transcript proves the /clear. The role must not be held
 * (`session-held`) or in an open handoff. The write uses the revision of `roles` and refuses
 * `rotation-conflict` when it changed. Any other failure rethrows `refusal`.
 */
async function rebindAfterClear(
  context: StoreServiceContext,
  options: CallerOptions,
  roles: Registry,
  refusal: unknown,
): Promise<{ actor: Caller; roles: Registry; rotation: SessionRotation }> {
  const nativeId = context.env[NATIVE_ID_VARIABLES.claude];
  const projects = claudeProjectsDir(context.env);
  if (
    !(refusal instanceof StoreError) ||
    refusal.code !== "caller-unbound" ||
    options.nativeId !== undefined ||
    nativeId === undefined ||
    !CONVERSATION_ID_PATTERN.test(nativeId) ||
    projects === null
  ) {
    throw refusal;
  }
  const from = clearPredecessor(projects, nativeId);
  if (from === null) {
    throw refusal;
  }
  const matches = Object.keys(roles.roles).filter(
    (role) => resolveHarness(roles, role) === "claude" && resolveConversation(roles, role) === from,
  );
  if (matches.length !== 1) {
    throw refusal;
  }
  const [role] = matches as [string];
  const { phase } = roles.roles[role]!;
  if (phase === "held" || phase === "source-held") {
    throw new ReasonedStoreError("session-held", `phase ${phase}`);
  }
  const handoffs = await withStore(context, (store) => openHandoffsFor(store, role).length, {
    createMissing: false,
  });
  if (handoffs > 0) {
    throw refusal;
  }
  let next: Registry;
  try {
    next = updateRegistry(context.clock, context.layout, roles.revision, (draft) => {
      draft.roles[role]!.conversations.claude = nativeId;
    });
  } catch (error) {
    if (error instanceof RevisionConflict) {
      throw new StoreError("rotation-conflict");
    }
    throw error;
  }
  return {
    actor: resolveCaller(next, context.env, options),
    roles: next,
    rotation: { from, revision: next.revision },
  };
}

function count(store: Store) {
  return (sql: string, ...args: string[]): number =>
    Number((store.db.prepare(sql).get(...args) as { n: number }).n);
}

/** The fenced caller, or the caller `rebindAfterClear` binds when the fence refuses it. */
async function bindCaller(
  context: StoreServiceContext,
  options: CallerOptions,
  roles: Registry,
): Promise<{ actor: Caller; roles: Registry; rotation?: SessionRotation }> {
  try {
    return { actor: resolveCaller(roles, context.env, options), roles };
  } catch (refusal) {
    return rebindAfterClear(context, options, roles, refusal);
  }
}

/**
 * Record a `session.started` event for the fenced caller and print its orientation: binding,
 * registry phase and ownership, checkpoint path, counts of pending questions, active holds that
 * cover it and open inbox messages, and its open handoffs. A held role is refused. An unbound
 * Claude caller with a proved /clear is rebound first, and the output carries `rotation`.
 */
export async function storeSessionStart(
  context: StoreServiceContext,
  options: CallerOptions,
  request: { readonly version: string; readonly cwd: string },
): Promise<SessionOutput> {
  const { actor, roles, rotation } = await bindCaller(context, options, registry(context));
  const record = roles.roles[actor.role]!;
  if (record.phase === "held" || record.phase === "source-held") {
    throw new ReasonedStoreError("session-held", `phase ${record.phase}`);
  }
  const harness = resolveHarness(roles, actor.role);
  const game = actor.role.includes("/") ? actor.role.split("/")[0]! : null;
  return withStore(context, (store) => {
    const event = recordSession(store, actor, { harness, key: randomUUID(), ...request });
    const n = count(store);
    const pending =
      harness === "codex"
        ? listQuestions(store, { role: actor.role, states: ["pending"] }).filter(
            (question) => question.codex !== undefined,
          )
        : [];
    return {
      checkpoint:
        context.layout.mode === "legacy"
          ? checkpointPath(actor.role)
          : relative(
              context.layout.root,
              join(context.layout.handoffsDir, actor.role, "current.md"),
            ),
      conversation: actor.nativeId,
      counts: {
        holds:
          n(
            `SELECT COUNT(*) AS n FROM holds WHERE state = 'active'
             AND ((role = ? AND scope = 'role') OR scope = ?)`,
            actor.role,
            game === null ? "" : `game:${game}`,
          ) + activePolicyHoldsForRole(store, actor.role, context.layout),
        inbox: n(
          `SELECT COUNT(*) AS n FROM messages WHERE to_role = ?
             AND state IN ('sent', 'delivered', 'retained')`,
          actor.role,
        ),
        questions: n(
          "SELECT COUNT(*) AS n FROM questions WHERE role = ? AND state = 'pending'",
          actor.role,
        ),
      },
      handoffs: openHandoffsFor(store, actor.role).map((handoff) => {
        const entry = handoff.roles.find((item) => item.role === actor.role)!;
        return {
          activeAt: entry.activeAt,
          id: handoff.id,
          readyAt: entry.readyAt,
          state: handoff.state,
          to: handoff.to,
        };
      }),
      harness,
      ...(pending.length === 0
        ? {}
        : {
            questionRecovery: {
              pending,
              unread: n(
                "SELECT COUNT(*) AS n FROM messages WHERE to_role = ? AND state = 'sent'",
                actor.role,
              ),
            },
          }),
      registry: {
        ownership: record.ownership,
        phase: record.phase ?? null,
        revision: roles.revision,
      },
      role: actor.role,
      ...(rotation === undefined ? {} : { rotation }),
      schema: 1 as const,
      session: { at: event.at, cwd: request.cwd, seq: event.seq, version: request.version },
    };
  });
}

function handoffOperator(
  roles: Registry,
  context: StoreServiceContext,
  options: CallerOptions,
): Actor {
  const actor = resolveCaller(roles, context.env, options);
  requirePermission(context.layout, roles, actor, "handoff:manage");
  return actor;
}

export interface HandoffOutput extends HandoffResult {
  readonly schema: 1;
}

/** Open a handoff for explicit roles, or `all` registered roles not yet on `to`. */
export async function storeHandoffOpen(
  context: StoreServiceContext,
  options: CallerOptions,
  request: { readonly scope: readonly string[]; readonly to: Harness; readonly id?: string },
): Promise<HandoffOutput> {
  const roles = registry(context);
  const actor = handoffOperator(roles, context, options);
  const all = request.scope.includes("all");
  if (all && request.scope.length > 1) {
    throw new StoreError("invalid-scope");
  }
  const names = all
    ? Object.keys(roles.roles).filter((role) => resolveHarness(roles, role) !== request.to)
    : [...new Set(request.scope)];
  for (const role of names) {
    if (!Object.hasOwn(roles.roles, role)) {
      throw new StoreError("role-unregistered");
    }
  }
  return withStore(context, (store) => ({
    ...openHandoff(store, actor, {
      roles: names.map((role) => ({ from: resolveHarness(roles, role), role })),
      to: request.to,
      ...(request.id === undefined ? {} : { id: request.id }),
    }),
    schema: 1 as const,
  }));
}

export async function storeHandoffReady(
  context: StoreServiceContext,
  options: CallerOptions,
  request: { readonly id?: string },
): Promise<HandoffOutput> {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  return withStore(context, (store) => ({
    ...readyHandoff(store, actor, { ...request, harness: resolveHarness(roles, actor.role) }),
    schema: 1 as const,
  }));
}

export async function storeHandoffActive(
  context: StoreServiceContext,
  options: CallerOptions,
  request: { readonly id?: string },
): Promise<HandoffOutput & { readonly wake: { readonly status: WakeStatus } | null }> {
  const roles = registry(context);
  const actor = resolveCaller(roles, context.env, options);
  return withStore(context, async (store) => {
    const { released, ...result } = activeHandoff(store, actor, {
      ...request,
      harness: resolveHarness(roles, actor.role),
    });
    return {
      ...result,
      schema: 1 as const,
      wake: released ? await wakeOwner(context, store, actor.role) : null,
    };
  });
}

export async function storeHandoffState(
  context: StoreServiceContext,
  options: CallerOptions,
  request: { readonly id: string; readonly state: HandoffState },
): Promise<HandoffOutput & { readonly released: readonly string[] }> {
  const actor = handoffOperator(registry(context), context, options);
  return withStore(context, async (store) => {
    const result = setHandoffState(store, actor, request.id, request.state);
    for (const role of result.released) {
      // One guarded wake per released role, each on its own fresh registry read.
      // eslint-disable-next-line no-await-in-loop
      await wakeOwner(context, store, role);
    }
    return { ...result, schema: 1 as const };
  });
}

/** The named handoff, or the latest one, with its holds; null when there is none. */
export async function storeHandoffShow(
  context: StoreServiceContext,
  request: { readonly id?: string },
): Promise<{
  readonly schema: 1;
  readonly handoff: HandoffView | null;
  readonly holds: readonly HoldView[];
}> {
  return withStore(
    context,
    (store) => {
      const handoff =
        request.id === undefined ? latestHandoff(store) : readHandoff(store, request.id);
      if (request.id !== undefined && handoff === null) {
        throw new StoreError("handoff-missing");
      }
      return {
        handoff,
        holds: handoff === null ? [] : handoffHolds(store, handoff),
        schema: 1 as const,
      };
    },
    { createMissing: false },
  );
}
