// The role-name review route, var/route.json schema 2. It names roles only; every send resolves
// them through var/registry.json for each role's selected harness at that moment. The review's
// recipient is the host game's reports.recipient.
import { existsSync } from "node:fs";

import { loadReportsConfig } from "../../core/config.ts";
import { readJson } from "../../core/durable.ts";
import {
  type GameCoordinatorConfig,
  gameLayout,
  type Layout,
  roleKeys,
} from "../../core/layout.ts";
import { isRecord } from "../../core/pyjson.ts";

export interface RoleRoute {
  readonly schema: 2;
  readonly state: "active" | "held";
  /** The game whose runner dispatches the scheduled review. */
  readonly host: string;
  readonly targets: readonly string[];
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

const ROUTE_KEYS = ["host", "schema", "state", "targets"];

/** The edit a schema 1 route needs. */
export const ROUTE_SCHEMA_1 =
  'var/route.json schema 1 is not supported: remove "monitor" and set "schema" to 2; ' +
  "scheduled reviews go to the host game's reports.recipient";

/** Validate a schema 2 route against config.json; throws RouteError when it is not one. */
export function validateRoleRoute(config: GameCoordinatorConfig, value: unknown): RoleRoute {
  if (isRecord(value) && (value.schema === 1 || Object.hasOwn(value, "monitor"))) {
    throw new RouteError(ROUTE_SCHEMA_1);
  }
  const roles = new Set(roleKeys(config));
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== ROUTE_KEYS.join() ||
    value.schema !== 2 ||
    (value.state !== "active" && value.state !== "held") ||
    typeof value.host !== "string" ||
    !Object.hasOwn(config.games, value.host) ||
    !Array.isArray(value.targets)
  ) {
    throw new RouteError("invalid review route schema");
  }
  const targets = value.targets as unknown[];
  if (targets.some((target) => typeof target !== "string" || !roles.has(target))) {
    throw new RouteError("every route target must be a role in config.json");
  }
  const names = targets as string[];
  if (new Set(names).size !== names.length) {
    throw new RouteError("route targets must be distinct");
  }
  if (value.state === "active" && names.length === 0) {
    throw new RouteError("an active route needs at least one target");
  }
  return { host: value.host, schema: 2, state: value.state, targets: names };
}

/** Read and validate var/route.json against config.json; null when no route is declared. */
export function readRoleRoute(layout: Layout): RoleRoute | null {
  if (!existsSync(layout.routeFile)) {
    return null;
  }
  let value: unknown;
  try {
    value = readJson(layout.routeFile);
  } catch {
    throw new RouteError("review route is unreadable");
  }
  return validateRoleRoute(layout.config, value);
}

/**
 * The role that receives the route's scheduled review: the host game's reports.recipient, which
 * must be a role in config.json. An active route whose targets include it is invalid.
 */
export function routeRecipient(layout: Layout, route: RoleRoute): string {
  let recipient: string;
  try {
    recipient = loadReportsConfig(gameLayout(layout, route.host).configFile).reports.recipient;
  } catch {
    throw new RouteError(`the route host ${route.host} has no readable reports.recipient`);
  }
  if (!roleKeys(layout.config).includes(recipient)) {
    throw new RouteError(`the route recipient ${recipient} is not a role in config.json`);
  }
  if (route.state === "active" && route.targets.includes(recipient)) {
    throw new RouteError(`active route targets must not include the recipient ${recipient}`);
  }
  return recipient;
}
