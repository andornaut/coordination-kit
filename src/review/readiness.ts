// Read-only adapter and conversation readiness for a target harness or each role's selection.
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { listingOrNull } from "../adapters/claude/agents.ts";
import { connectControl } from "../adapters/codex/rpc.ts";
import { resolveCodexControlSocket } from "../adapters/shared/endpoints.ts";
import {
  configuredReviewRecipient,
  readRoleRoute,
  routeRecipient,
} from "../adapters/shared/route.ts";
import { gameRecipients } from "../core/configuration/delivery.ts";
import type { Layout } from "../core/configuration/layout.ts";
import { resolveHarness } from "../registry/resolve.ts";
import type { Harness, Registry } from "../registry/schema.ts";
import { resolveSelectedRoles, type RoleSelection } from "../registry/selection.ts";

interface RoleReadiness {
  readonly role: string;
  readonly conversation: string | null;
  readonly status: "resolved" | "unavailable";
  readonly current_harness?: Harness;
  readonly probed_harness?: Harness;
}

export type ReadinessScope = RoleSelection;

interface SelectedRoleReadiness extends RoleReadiness {
  readonly current_harness: Harness;
  readonly probed_harness: Harness;
}

interface Readiness {
  readonly harness: Harness;
  readonly adapter: {
    readonly status: "available" | "unavailable";
    readonly reason: string | null;
  };
  readonly roles: readonly RoleReadiness[];
  readonly ready: boolean;
}

interface EffectiveReadiness {
  readonly harness: "mixed";
  readonly adapters: Readonly<Partial<Record<Harness, Readiness["adapter"]>>>;
  readonly roles: readonly SelectedRoleReadiness[];
  readonly ready: boolean;
}

const PROBE_MS = 5000;
const EXPLICIT_SOCKET_REQUIRED =
  "set CODEX_CONTROL_SOCKET to an available absolute Codex control socket path";

async function codexAdapterStatus(env: NodeJS.ProcessEnv): Promise<string | null> {
  let endpoint;
  try {
    endpoint = resolveCodexControlSocket({ env });
  } catch {
    return EXPLICIT_SOCKET_REQUIRED;
  }
  const unavailable =
    endpoint.source === "managed"
      ? "the managed Codex control socket is unavailable"
      : EXPLICIT_SOCKET_REQUIRED;
  try {
    if (!statSync(endpoint.path).isSocket()) {
      return unavailable;
    }
  } catch {
    return unavailable;
  }
  try {
    (await connectControl(performance.now() + PROBE_MS, endpoint.path)).close();
    return null;
  } catch {
    return "the Codex control socket refused the connection";
  }
}

function adapterStatus(env: NodeJS.ProcessEnv, harness: Harness): Promise<string | null> {
  if (harness === "codex") {
    return codexAdapterStatus(env);
  }
  return Promise.resolve(
    listingOrNull(env) === null ? "claude agents --json is unavailable" : null,
  );
}

/**
 * The route recipient first, then each route target; without a route, every app's recipient.
 * Null for an invalid route or an unreadable recipient, which is never ready.
 */
function routeRoles(layout: Layout, registry: Registry): string[] | null {
  try {
    const route = readRoleRoute(layout);
    let roles: string[];
    if (route !== null) {
      roles = [routeRecipient(layout, route), ...route.targets];
    } else if (layout.mode === "app") {
      const recipients = Object.keys(layout.config.apps).map((app) =>
        configuredReviewRecipient(layout, app),
      );
      roles = [...new Set(recipients)];
    } else {
      roles = gameRecipients(layout, Object.keys(layout.config.games));
    }
    return layout.mode !== "app" || roles.every((role) => Object.hasOwn(registry.roles, role))
      ? roles
      : null;
  } catch {
    return null;
  }
}

export async function harnessReadiness(
  env: NodeJS.ProcessEnv,
  layout: Layout,
  registry: Registry,
  harness: Harness,
  scope?: ReadinessScope,
): Promise<Readiness> {
  const names =
    scope === undefined
      ? routeRoles(layout, registry)
      : resolveSelectedRoles(layout, registry, scope);
  const reason = await adapterStatus(env, harness);
  const roles = (names ?? []).map((role): RoleReadiness => {
    const conversation = registry.roles[role]?.conversations[harness] ?? null;
    return {
      conversation,
      ...(scope === undefined
        ? {}
        : { current_harness: resolveHarness(registry, role), probed_harness: harness }),
      role,
      status: conversation === null ? "unavailable" : "resolved",
    };
  });
  return {
    adapter: { reason, status: reason === null ? "available" : "unavailable" },
    harness,
    ready: reason === null && names !== null && roles.every((role) => role.status === "resolved"),
    roles,
  };
}

/** Current role selections, with one adapter probe per required harness and no sends. */
export async function effectiveReadiness(
  env: NodeJS.ProcessEnv,
  layout: Layout,
  registry: Registry,
  scope?: ReadinessScope,
): Promise<EffectiveReadiness> {
  const names =
    scope === undefined
      ? routeRoles(layout, registry)
      : resolveSelectedRoles(layout, registry, scope);
  const roles = (names ?? []).map((role): SelectedRoleReadiness => {
    const harness = resolveHarness(registry, role);
    const conversation = registry.roles[role]?.conversations[harness] ?? null;
    return {
      conversation,
      current_harness: harness,
      probed_harness: harness,
      role,
      status: conversation === null ? "unavailable" : "resolved",
    };
  });
  const harnesses = [...new Set(roles.map((role) => role.probed_harness))].sort();
  const entries = await Promise.all(
    harnesses.map(async (harness) => {
      const reason = await adapterStatus(env, harness);
      return [harness, { reason, status: reason === null ? "available" : "unavailable" }] as const;
    }),
  );
  const adapters = Object.fromEntries(entries);
  return {
    adapters,
    harness: "mixed",
    ready:
      names !== null &&
      roles.every((role) => role.status === "resolved") &&
      entries.every(([, adapter]) => adapter.status === "available"),
    roles,
  };
}
