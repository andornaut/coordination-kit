// Recipient-bound user-decision clearance. The marker is written by the
// recipient's owner; this kit only reads it. A missing or invalid marker is never clearance.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { gameLayout, type Layout } from "../../layout.ts";
import { CANONICAL_UUID } from "./ids.ts";
import { readRoleRoute } from "./route.ts";

const FIELDS = [
  "question_turn_id",
  "question_item_id",
  "answer_turn_id",
  "answer_item_id",
] as const;

export type DecisionRecord = Readonly<Record<string, unknown>>;

export type DecisionMarkerInspection =
  | { readonly state: "clear" | "pending"; readonly record: DecisionRecord }
  | { readonly state: "absent" | "unreadable"; readonly record: null }
  | { readonly state: "invalid"; readonly record: DecisionRecord | null };

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
    return { record: null, state: "invalid" };
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
    return { record: null, state: "invalid" };
  }
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    return { record: null, state: "invalid" };
  }
  const record = marker as DecisionRecord;
  if (record.thread_id !== recipient) {
    return { record: null, state: "invalid" };
  }
  const resolutions = Object.hasOwn(record, "resolutions") ? record.resolutions : [];
  if (!Array.isArray(resolutions)) {
    return { record: null, state: "invalid" };
  }
  const seen = new Set<string>();
  for (const resolution of resolutions as unknown[]) {
    if (typeof resolution !== "object" || resolution === null) {
      return { record: null, state: "invalid" };
    }
    const entry = resolution as Record<string, unknown>;
    if (FIELDS.some((field) => typeof entry[field] !== "string" || entry[field] === "")) {
      return { record: null, state: "invalid" };
    }
    const reference = JSON.stringify([entry.question_turn_id, entry.question_item_id]);
    if (seen.has(reference)) {
      return { record: null, state: "invalid" };
    }
    seen.add(reference);
  }
  const state = record.state;
  return state === "clear" || state === "pending"
    ? { record, state }
    : { record, state: "invalid" };
}

/** The validated marker in `<unblock>/decisions/<recipient>.json`, or null. */
export function decisionRecord(unblockDir: string, recipient: string): DecisionRecord | null {
  return inspectDecisionMarker(unblockDir, recipient).record;
}

export function decisionClear(unblockDir: string, recipient: string): boolean {
  return inspectDecisionMarker(unblockDir, recipient).state === "clear";
}

/** The bus `unblock` directory holding a role's local decision markers, or null. */
export function decisionDirectory(layout: Layout, role: string): string | null {
  try {
    const game = role.split("/")[0]!;
    if (role.includes("/")) {
      return Object.hasOwn(layout.config.games, game)
        ? join(gameLayout(layout, game).busDir, "unblock")
        : null;
    }
    const route = readRoleRoute(layout);
    return route?.state === "active"
      ? join(gameLayout(layout, route.host).busDir, "unblock")
      : null;
  } catch {
    return null;
  }
}
