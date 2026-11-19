// Delivery evidence from one history pass: each item's landing commit on `main`, reachability from
// `main` and `origin/main`, and the first deployment that contains a commit. Pure functions over
// the parsed history; nothing here runs git.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Commit, History } from "./git.ts";

const WORK_PREFIX = "docs/work/";
const DESIGN_PREFIX = "docs/design/";
const ID_TOKEN = /(?<![\w-])([a-z][a-z0-9]*-\d{4,})(?!\w)/g;
const SHA = /^[0-9a-f]{40}$/;

export type LandingRule = "id" | "work-file" | "title";

export interface Landing {
  readonly sha: string;
  readonly at: string;
  /** Which citation matched: the ID in the message, a change to the work file, or the title. */
  readonly rule: LandingRule;
}

export interface LandingItem {
  readonly id: string;
  /** Repository-relative work file path. */
  readonly path: string;
  readonly title: string | null;
}

export interface Landings {
  readonly landing: ReadonlyMap<string, Landing>;
  /** The oldest commit on `main` that added each item's work file (its proposal or approval). */
  readonly addedIn: ReadonlyMap<string, string>;
}

/** Every commit reachable from `tip`, from the parsed parent links. */
export function reachable(history: History, tip: string | null): Set<string> {
  const parents = new Map(history.commits.map((commit) => [commit.sha, commit.parents]));
  const seen = new Set<string>();
  const stack = tip === null ? [] : [tip];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha) || !parents.has(sha)) {
      continue;
    }
    seen.add(sha);
    stack.push(...parents.get(sha)!);
  }
  return seen;
}

function bookkeeping(commit: Commit): boolean {
  return commit.changes.every((change) =>
    [change.path, ...(change.from === undefined ? [] : [change.from])].every(
      (path) => path.startsWith(WORK_PREFIX) || path.startsWith(DESIGN_PREFIX),
    ),
  );
}

/**
 * The landing commit of each item: the oldest commit reachable from local `main` that cites the
 * item and is not bookkeeping. A commit cites an item when its message names the ID as a whole
 * token, when it changes the item's work file (or a path later renamed to it), or when its subject
 * equals the item's title. Bookkeeping commits never land an item: those that change only
 * docs/work/ and docs/design/, and the commit that adds the item's work file.
 */
export function findLandings(
  history: History,
  onMain: ReadonlySet<string>,
  items: readonly LandingItem[],
): Landings {
  const ids = new Set(items.map((item) => item.id));
  const owner = new Map(items.map((item) => [item.path, item.id]));
  const pathOf = new Map(items.map((item) => [item.id, item.path]));
  const byTitle = new Map<string, string[]>();
  for (const item of items) {
    if (item.title !== null && item.title !== "") {
      byTitle.set(item.title, [...(byTitle.get(item.title) ?? []), item.id]);
    }
  }
  const landing = new Map<string, Landing>();
  const addedIn = new Map<string, string>();
  // Newest first, so a rename seen here names the item that older commits on the old path serve.
  for (const commit of history.commits) {
    if (!onMain.has(commit.sha)) {
      continue;
    }
    const cited = new Map<string, LandingRule>();
    const added = new Set<string>();
    for (const match of commit.message.matchAll(ID_TOKEN)) {
      const id = match[1]!;
      if (ids.has(id) && !cited.has(id)) {
        cited.set(id, "id");
      }
    }
    for (const change of commit.changes) {
      const id = owner.get(change.path);
      if (id === undefined) {
        continue;
      }
      if (!cited.has(id)) {
        cited.set(id, "work-file");
      }
      if (change.status === "A" || change.status === "R" || change.status === "C") {
        added.add(id);
        if (pathOf.get(id) === change.path) {
          addedIn.set(id, commit.sha);
        }
      }
    }
    for (const id of byTitle.get(commit.subject) ?? []) {
      if (!cited.has(id)) {
        cited.set(id, "title");
      }
    }
    if (!bookkeeping(commit)) {
      for (const [id, rule] of cited) {
        if (!added.has(id)) {
          landing.set(id, { at: commit.at, rule, sha: commit.sha });
        }
      }
    }
    for (const change of commit.changes) {
      const id = owner.get(change.path);
      if (change.from !== undefined && change.status === "R" && id !== undefined) {
        owner.set(change.from, id);
      }
    }
  }
  return { addedIn, landing };
}

export interface DeployPoint {
  readonly sha: string;
  readonly at: string;
  /** `complete` for a runner COMPLETE event, `release` for a release tag. */
  readonly via: "complete" | "release";
  readonly tag: string | null;
  /** Chronological order key: event nanoseconds or tag commit milliseconds. */
  readonly order: bigint;
}

/**
 * The first deployment containing each commit. Points are taken in chronological order; each marks
 * the commits it reaches that no earlier point reached, so the marked set stays closed under
 * ancestry and every commit is visited once.
 */
export function deploymentMarks(
  history: History,
  points: readonly DeployPoint[],
): Map<string, DeployPoint> {
  const parents = new Map(history.commits.map((commit) => [commit.sha, commit.parents]));
  const marks = new Map<string, DeployPoint>();
  const ordered = [...points].sort((left, right) =>
    left.order === right.order ? 0 : left.order < right.order ? -1 : 1,
  );
  for (const point of ordered) {
    const stack = [point.sha];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (marks.has(sha) || !parents.has(sha)) {
        continue;
      }
      marks.set(sha, point);
      stack.push(...parents.get(sha)!);
    }
  }
  return marks;
}

/** Each release tag in the history as a deployment point, timed by its commit. */
export function releasePoints(history: History): DeployPoint[] {
  return history.commits.flatMap((commit) =>
    commit.tags.map((tag) => ({
      at: commit.at,
      order: BigInt(Date.parse(commit.at)),
      sha: commit.sha,
      tag,
      via: "release" as const,
    })),
  );
}

export interface BusRead {
  /** `absent` when the game has no events directory yet. */
  readonly status: "available" | "absent";
  readonly points: readonly DeployPoint[];
  /** Event files that could not be parsed; they are not counted as deployments. */
  readonly unreadable: number;
}

/**
 * Every runner COMPLETE event in a game's bus outbox (`<bus>/events/<id>.json`, kind `complete`,
 * key the pushed SHA), timed by its nanosecond `created` stamp.
 */
export function readCompleteEvents(busDir: string): BusRead {
  const directory = join(busDir, "events");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { points: [], status: "absent", unreadable: 0 };
    }
    throw error;
  }
  const points: DeployPoint[] = [];
  let unreadable = 0;
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const text = readFileSync(join(directory, name), "utf8");
      const event = JSON.parse(text) as { kind?: unknown; key?: unknown };
      if (event.kind !== "complete" || typeof event.key !== "string" || !SHA.test(event.key)) {
        continue;
      }
      const created = /"created":\s*(\d+)\b/.exec(text)?.[1];
      if (created === undefined) {
        unreadable += 1;
        continue;
      }
      const order = BigInt(created);
      points.push({
        at: new Date(Number(order / 1_000_000n)).toISOString(),
        order,
        sha: event.key,
        tag: null,
        via: "complete",
      });
    } catch {
      unreadable += 1;
    }
  }
  return { points, status: "available", unreadable };
}
