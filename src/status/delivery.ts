// Delivery evidence from one history pass: each item's landing commit on `main`, reachability from
// `main` and `origin/main`, and the first deployment that contains a commit. Pure functions over
// the parsed history; nothing here runs git.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Commit, CommitRef, History } from "../core/git.ts";

const WORK_PREFIX = "docs/work/";
const DESIGN_PREFIX = "docs/design/";
const ID_TOKEN = /(?<![\w-])([a-z][a-z0-9]*-\d{4,})(?!\w)/g;
const SHA = /^[0-9a-f]{40}$/;

export type LandingRule = "done-flip" | "id" | "title";

export interface Landing {
  readonly sha: string;
  readonly at: string;
  /** Which rule matched: the commit setting `status: done`, the ID in the message, or the title. */
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
 * The landing commit of each item. Primary: the first commit on `main` whose change sets the work
 * file's front matter to `status: done` (integration sets `done` in the merge), from `doneAt`.
 * Otherwise the oldest commit reachable from local `main` that is not bookkeeping and whose
 * message names the ID as a whole token, or whose subject equals the item's title. Bookkeeping
 * commits change only docs/work/ and docs/design/, or add the item's work file.
 */
export function findLandings(
  history: History,
  onMain: ReadonlySet<string>,
  items: readonly LandingItem[],
  doneAt: ReadonlyMap<string, CommitRef>,
): Landings {
  const ids = new Set(items.map((item) => item.id));
  const owner = new Map(items.map((item) => [item.path, item.id]));
  const byTitle = new Map<string, string[]>();
  for (const item of items) {
    if (item.title !== null && item.title !== "") {
      byTitle.set(item.title, [...(byTitle.get(item.title) ?? []), item.id]);
    }
  }
  const landing = new Map<string, Landing>();
  const addedIn = new Map<string, string>();
  // Newest first: the last assignment for an item is its oldest qualifying commit.
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
    for (const id of byTitle.get(commit.subject) ?? []) {
      if (!cited.has(id)) {
        cited.set(id, "title");
      }
    }
    for (const change of commit.changes) {
      const id = owner.get(change.path);
      if (id !== undefined && ["A", "R", "C"].includes(change.status)) {
        added.add(id);
        addedIn.set(id, commit.sha);
      }
    }
    if (!bookkeeping(commit)) {
      for (const [id, rule] of cited) {
        if (!added.has(id)) {
          landing.set(id, { at: commit.at, rule, sha: commit.sha });
        }
      }
    }
  }
  for (const item of items) {
    const flip = doneAt.get(item.path);
    if (flip !== undefined) {
      landing.set(item.id, { at: flip.at, rule: "done-flip", sha: flip.sha });
    }
  }
  return { addedIn, landing };
}

export interface DeployPoint {
  readonly sha: string;
  /** Null for a `last-deploy.sha` whose `last-deploy` time is missing or unreadable. */
  readonly at: string | null;
  /** A runner deployment or legacy COMPLETE event, the last deploy marker, or a release tag. */
  readonly via: "complete" | "deploy-event" | "last-deploy" | "release";
  readonly tag: string | null;
  /** Work IDs listed by a deployment event or legacy COMPLETE event; empty otherwise. */
  readonly work: readonly string[];
  /** Chronological order key: nanoseconds for bus points, milliseconds for release tags. */
  readonly order: bigint;
}

/** Orders a point with no time after every timed one. */
const UNTIMED = 2n ** 80n;

interface StoredDeploy {
  readonly at: string;
  readonly sha: string;
  readonly type: "complete" | "deploy_success";
  readonly work: string | null;
}

/** Convert one stored runner success event, with its exact time and optional work list. */
export function storedDeployPoint(row: StoredDeploy): DeployPoint {
  const at = Date.parse(row.at);
  const work: unknown = row.work === null ? null : JSON.parse(row.work);
  return {
    at: new Date(at).toISOString(),
    order: BigInt(at) * 1_000_000n,
    sha: row.sha,
    tag: null,
    via: row.type === "complete" ? "complete" : "deploy-event",
    work: Array.isArray(work) ? work.filter((id): id is string => typeof id === "string") : [],
  };
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
      work: [],
    })),
  );
}

export interface BusRead {
  /** `absent` when the game has neither an events directory nor a `last-deploy.sha` yet. */
  readonly status: "available" | "absent";
  readonly points: readonly DeployPoint[];
  /** Event or last-deploy files that could not be parsed; they count as no deployment. */
  readonly unreadable: number;
}

function optionalText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * A game's deployment points from its bus: every runner COMPLETE event in the outbox
 * (`<bus>/events/<id>.json`, kind `complete`, key the pushed SHA, timed by its nanosecond `created`
 * stamp, with an optional `work` array of IDs), and the runner's last deployed SHA
 * (`<bus>/last-deploy.sha`, timed by the epoch seconds in `<bus>/last-deploy`).
 */
export function readBusDeployments(busDir: string): BusRead {
  const directory = join(busDir, "events");
  let names: string[] | null;
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    names = null;
  }
  const points: DeployPoint[] = [];
  let unreadable = 0;
  for (const name of (names ?? []).filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const text = readFileSync(join(directory, name), "utf8");
      const event = JSON.parse(text) as { kind?: unknown; key?: unknown; work?: unknown };
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
        work: Array.isArray(event.work)
          ? event.work.filter((id): id is string => typeof id === "string")
          : [],
      });
    } catch {
      unreadable += 1;
    }
  }
  const last = optionalText(join(busDir, "last-deploy.sha"));
  if (last !== null) {
    const sha = last.trim();
    if (SHA.test(sha)) {
      const seconds = (optionalText(join(busDir, "last-deploy")) ?? "").trim();
      const timed = /^\d+$/.test(seconds);
      points.push({
        at: timed ? new Date(Number(seconds) * 1000).toISOString() : null,
        order: timed ? BigInt(seconds) * 1_000_000_000n : UNTIMED,
        sha,
        tag: null,
        via: "last-deploy",
        work: [],
      });
    } else if (sha !== "") {
      unreadable += 1;
    }
  }
  return { points, status: names === null && last === null ? "absent" : "available", unreadable };
}

/** The first deployment point listing each work ID in its optional `work` array. */
export function workListings(points: readonly DeployPoint[]): Map<string, DeployPoint> {
  const listed = new Map<string, DeployPoint>();
  const ordered = [...points].sort((left, right) =>
    left.order === right.order ? 0 : left.order < right.order ? -1 : 1,
  );
  for (const point of ordered) {
    for (const id of point.work) {
      if (!listed.has(id)) {
        listed.set(id, point);
      }
    }
  }
  return listed;
}
