// Read-only recipient decision markers. The scheduled review reports a Codex role's marker
// structure and passes its resolutions to the native question collectors. No wake depends on a
// marker.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appLayout, type Layout } from "../../core/configuration/layout.ts";
import { CANONICAL_UUID } from "../../core/ids.ts";
import { readRoleRoute } from "./route.ts";

const FIELDS = [
  "question_turn_id",
  "question_item_id",
  "answer_turn_id",
  "answer_item_id",
] as const;

type DecisionRecord = Readonly<Record<string, unknown>>;

export type DecisionMarkerDiagnostic =
  | { readonly state: "clear" | "pending" | "absent" | "unreadable" }
  | {
      readonly state: "invalid";
      readonly reason:
        | "recipient-id"
        | "json"
        | "record"
        | "thread-binding"
        | "resolutions"
        | "resolution"
        | "resolution-fields"
        | "duplicate-resolution"
        | "state";
      readonly fields?: readonly (typeof FIELDS)[number][];
    };

export type DecisionMarkerInspection = DecisionMarkerDiagnostic & {
  readonly record: DecisionRecord | null;
};

function markerAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Distinguish a missing marker, malformed evidence and a failed filesystem read. */
export function inspectDecisionMarker(
  unblockDir: string,
  recipient: string,
): DecisionMarkerInspection {
  if (!CANONICAL_UUID.test(recipient)) {
    return { reason: "recipient-id", record: null, state: "invalid" };
  }
  const path = join(unblockDir, "decisions", `${recipient}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT" && markerAbsent(path);
    return { record: null, state: absent ? "absent" : "unreadable" };
  }
  let marker: unknown;
  try {
    marker = JSON.parse(raw) as unknown;
  } catch {
    return { reason: "json", record: null, state: "invalid" };
  }
  return inspectDecisionRecord(marker, recipient);
}

/** Validate an in-memory marker using the same rules as the wake guard. */
function inspectDecisionRecord(marker: unknown, recipient: string): DecisionMarkerInspection {
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    return { reason: "record", record: null, state: "invalid" };
  }
  const record = marker as DecisionRecord;
  if (record.thread_id !== recipient) {
    return { reason: "thread-binding", record: null, state: "invalid" };
  }
  const resolutions = Object.hasOwn(record, "resolutions") ? record.resolutions : [];
  if (!Array.isArray(resolutions)) {
    return { reason: "resolutions", record: null, state: "invalid" };
  }
  const seen = new Set<string>();
  for (const resolution of resolutions as unknown[]) {
    if (typeof resolution !== "object" || resolution === null) {
      return { reason: "resolution", record: null, state: "invalid" };
    }
    const entry = resolution as Record<string, unknown>;
    const fields = FIELDS.filter(
      (field) => typeof entry[field] !== "string" || entry[field] === "",
    );
    if (fields.length > 0) {
      return { fields, reason: "resolution-fields", record: null, state: "invalid" };
    }
    const reference = JSON.stringify([entry.question_turn_id, entry.question_item_id]);
    if (seen.has(reference)) {
      return { reason: "duplicate-resolution", record: null, state: "invalid" };
    }
    seen.add(reference);
  }
  const state = record.state;
  return state === "clear" || state === "pending"
    ? { record, state }
    : { reason: "state", record, state: "invalid" };
}

/** The bus `unblock` directory holding a role's local decision markers, or null. */
export function decisionDirectory(layout: Layout, role: string): string | null {
  try {
    const apps = Object.entries(layout.config.apps).filter(([, app]) => app.roles.includes(role));
    if (apps.length === 1) {
      return join(appLayout(layout, apps[0]![0]).busDir, "unblock");
    }
    if (apps.length !== 0 || !layout.config.sharedRoles.includes(role)) {
      return null;
    }
    const route = readRoleRoute(layout);
    return route?.state === "active" ? join(appLayout(layout, route.host).busDir, "unblock") : null;
  } catch {
    return null;
  }
}
