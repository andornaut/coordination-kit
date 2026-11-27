// Scoped transport selection changes no activation or ownership evidence.
import type { Clock } from "../core/clock.ts";
import { appRoleKeys, type Layout } from "../core/configuration/layout.ts";
import { checkArray, checkEnum, checkObject, checkString, Issues } from "../core/validate.ts";
import { resolveRole } from "./resolve.ts";
import { type Harness, HARNESSES, type Registry } from "./schema.ts";
import { type UpdateOptions, updateRegistry } from "./store.ts";

export interface RoleSelection {
  readonly apps?: readonly string[];
  /** Compatibility spelling for selecting an app. */
  readonly games?: readonly string[];
  /** Registered role keys. */
  readonly roles?: readonly string[];
}

export interface HarnessSelection extends RoleSelection {
  readonly harness: Harness | "default";
}

/** Resolve an explicit nonempty selection without changing registry state. */
export function resolveSelectedRoles(
  layout: Layout,
  registry: Registry,
  selection: RoleSelection,
): readonly string[] {
  const issues = new Issues();
  if (checkObject(issues, "", { optional: ["apps", "games", "roles"], required: [] }, selection)) {
    for (const key of ["apps", "games", "roles"] as const) {
      const names = selection[key];
      if (
        names !== undefined &&
        checkArray(issues, `/${key}`, { nonEmpty: true, unique: true }, names)
      ) {
        names.forEach((name, index) => checkString(issues, `/${key}/${index}`, null, name));
      }
    }
    if (selection.apps !== undefined && selection.games !== undefined) {
      issues.add("/", "use apps or games for the app selection");
    }
    if (
      selection.apps === undefined &&
      selection.games === undefined &&
      selection.roles === undefined
    ) {
      issues.add("/", "select at least one app or role");
    }
  }
  issues.throwIfAny("role selection");
  const names = [...(selection.roles ?? [])];
  for (const app of selection.apps ?? selection.games ?? []) {
    if (!Object.hasOwn(layout.config.apps, app)) {
      if (selection.apps === undefined) {
        issues.add("/games", `unknown game: ${app}`);
      } else {
        issues.add("/apps", `unknown app: ${app}`);
      }
    } else {
      names.push(...appRoleKeys(layout.config, app));
    }
  }
  issues.throwIfAny("role selection");
  return [...new Set(names.map((name) => resolveRole(registry, name)))].sort();
}

/** Atomically select only named roles under the registry's revision-checked write lock. */
export function selectHarness(
  clock: Clock,
  layout: Layout,
  expectedRevision: number,
  selection: HarnessSelection,
  options: UpdateOptions = {},
): Registry {
  return updateRegistry(
    clock,
    layout,
    expectedRevision,
    (draft) => {
      const issues = new Issues();
      if (
        checkObject(
          issues,
          "",
          { optional: ["apps", "games", "roles"], required: ["harness"] },
          selection,
        )
      ) {
        checkEnum(issues, "/harness", [...HARNESSES, "default"], selection.harness);
      }
      issues.throwIfAny("harness selection");
      const { apps, games, roles } = selection;
      const keys = resolveSelectedRoles(layout, draft, {
        ...(apps === undefined ? {} : { apps }),
        ...(games === undefined ? {} : { games }),
        ...(roles === undefined ? {} : { roles }),
      });
      // Verify every selected endpoint before changing any role.
      for (const key of keys) {
        const harness = selection.harness === "default" ? draft.harness : selection.harness;
        if (draft.roles[key]?.conversations[harness] == null) {
          issues.add(
            `/roles/${key}/conversations/${harness}`,
            "selected conversation is unavailable",
          );
        }
      }
      issues.throwIfAny("harness selection");
      for (const key of keys) {
        const role = draft.roles[key]!;
        if (selection.harness === "default") {
          delete role.harness;
        } else {
          role.harness = selection.harness;
        }
      }
    },
    options,
  );
}
