// `coordination-kit status`: every registered repository's work items joined with their store
// records, imported requests and delivery evidence, one derived status per item. Read-only:
// one history pass and one work-file pass per repository, and one read of the coordinator state.
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { Io } from "../io.ts";
import { gameLayout, type Layout, loadLayout } from "../layout.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import type { HoldView, QuestionView } from "../store/questions.ts";
import type { RequestRecord } from "../store/requests.ts";
import type { WorkRecord } from "../store/work.ts";
import { CONVENTION_FILE, fieldIds, parseFrontMatter } from "../work/files.ts";
import {
  deploymentMarks,
  type DeployPoint,
  findLandings,
  type Landing,
  reachable,
  readBusDeployments,
  releasePoints,
  workListings,
} from "./delivery.ts";
import {
  ACTIVE_LEDGER_STATES,
  CLOSED,
  type DeploymentChannel,
  type DerivedStatus,
  deriveWorkFile,
  type StateFilter,
} from "./derive.ts";
import { type GitRunner, readHistory, readMainFiles, repositoryRoot } from "./git.ts";
import { readStoreWork, type StoreWorkSnapshot } from "./sources.ts";

export const STATUS_SCHEMA = 2;
const WORK_DIRECTORY = "docs/work";

export class StatusUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatusUsageError";
  }
}

export interface StatusOptions {
  /** `all`, a game ID, a kit ID or a registry role key. */
  readonly scope: string;
  readonly since: string | null;
  /** Derived statuses, or `unverified` for done items without deployment evidence. */
  readonly states: readonly StateFilter[];
  readonly audit: boolean;
  /** Done items without evidence whose done commit is at or after this instant are unverified. */
  readonly verifySince: string;
}

export type RepositoryKind = "game" | "kit" | "coordinator" | "other";

export interface RepositoryStatus {
  readonly name: string;
  readonly kind: RepositoryKind;
  readonly path: string;
  readonly roles: readonly string[];
  readonly status: "available" | "unavailable";
  readonly reason: string | null;
  readonly main: string | null;
  readonly originMain: string | null;
  readonly deployment: {
    readonly channel: DeploymentChannel;
    /** `absent` for a game whose bus has no events directory yet. */
    readonly status: "available" | "absent" | "unavailable" | "not-applicable";
    readonly unreadable: number;
  };
}

export interface RequestEntry {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly owner: string;
  readonly question: string | null;
  readonly requiredOwner: string | null;
  readonly reason: string | null;
  readonly updatedAt: string;
  readonly userSource: boolean;
}

export interface UnmatchedRequest extends RequestEntry {
  readonly repository: string | null;
  readonly summary: string;
  readonly work: readonly string[];
  readonly closedAt: string | null;
}

type WorkTime = { readonly repository: string; readonly id: string; readonly at: string };

interface GitDeployment {
  readonly sha: string;
  readonly at: string | null;
  readonly via: DeployPoint["via"];
  readonly tag: string | null;
  readonly matched: "landing" | "work-list";
}

export interface StatusItem {
  readonly repository: string;
  readonly id: string;
  readonly title: string | null;
  readonly status: DerivedStatus;
  readonly replacement: string | null;
  readonly blocked: boolean;
  readonly blocker: string | null;
  readonly owner: string | null;
  readonly waitingOnUser: boolean;
  readonly userOriginated: boolean;
  readonly deliveryVerified: boolean | null;
  readonly deliveryEvidence: "deployed" | "assumed" | null;
  readonly latestEvidenceAt: string | null;
  readonly completedAt: string | null;
  readonly workFile: {
    readonly path: string;
    readonly status: string | null;
    readonly approved: string | null;
    readonly design: string | null;
    /** The IDs the work file's `supersedes` names: one ID or a list. */
    readonly supersedes: readonly string[];
    readonly addedIn: string | null;
    readonly commit: string;
    readonly committedAt: string;
  } | null;
  /** Imported requests that name this item, or the request itself for a request item. */
  readonly requests: readonly RequestEntry[];
  /** The item's store work record; null when the store is absent or holds none. */
  readonly store: WorkRecord | null;
  /** Which evidence set `landed` and `deployed`: store stage evidence is preferred to Git. */
  readonly deliverySource: {
    readonly landing: "store" | "git" | null;
    readonly deployment: "store" | "git" | null;
  };
  readonly delivery: {
    readonly landing: Landing | null;
    readonly onOrigin: boolean | null;
    readonly deployed: GitDeployment | null;
    /** A deployment containing only a title/ID match, which is insufficient to verify the work. */
    readonly heuristicDeployment: GitDeployment | null;
  };
}

export interface StatusReport {
  readonly schema: typeof STATUS_SCHEMA;
  readonly coordinator: {
    readonly root: string;
    readonly store: StoreWorkSnapshot["state"];
  };
  readonly filters: StatusOptions;
  readonly repositories: readonly RepositoryStatus[];
  readonly items: readonly StatusItem[];
  readonly pendingQuestions: readonly QuestionView[];
  readonly activeHolds: readonly HoldView[];
  readonly unmatchedRequests: readonly UnmatchedRequest[];
  readonly recentActivity: readonly WorkTime[];
  readonly recentCompletions: readonly WorkTime[];
}

export interface StatusContext {
  readonly io: Pick<Io, "env">;
  readonly git: GitRunner;
}

export interface Repository {
  readonly name: string;
  readonly kind: RepositoryKind;
  readonly path: string;
  readonly roles: string[];
  readonly reason: string | null;
}

function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** The config path behind a role: its game's or kit's repository, or the coordinator for others. */
function configPath(layout: Layout, role: string): string {
  const game = role.includes("/") ? role.split("/")[0]! : null;
  if (game !== null && Object.hasOwn(layout.config.games, game)) {
    return resolve(layout.root, layout.config.games[game]!.path);
  }
  if (Object.hasOwn(layout.config.kits, role)) {
    return resolve(layout.root, layout.config.kits[role]!.path);
  }
  return layout.root;
}

/** The distinct repositories behind the registry's roles, resolved through git and deduplicated. */
export function repositories(
  context: Pick<StatusContext, "git">,
  layout: Layout,
  registry: Registry,
): Repository[] {
  const known = new Map<string, { name: string; kind: RepositoryKind }>();
  for (const [id, entry] of Object.entries(layout.config.games)) {
    const path = real(resolve(layout.root, entry.path));
    if (path !== null) {
      known.set(path, { kind: "game", name: id });
    }
  }
  for (const [id, entry] of Object.entries(layout.config.kits)) {
    const path = real(resolve(layout.root, entry.path));
    if (path !== null) {
      known.set(path, { kind: "kit", name: id });
    }
  }
  const coordinator = real(layout.root);
  if (coordinator !== null) {
    known.set(coordinator, { kind: "coordinator", name: "game-coordinator" });
  }
  const found = new Map<string, Repository>();
  for (const role of Object.keys(registry.roles).sort()) {
    const candidates = [
      resolve(layout.root, registry.roles[role]!.worktree),
      configPath(layout, role),
    ];
    let root: string | null = null;
    let failure = "repository-unavailable";
    for (const candidate of candidates) {
      try {
        root = real(repositoryRoot(context.git, candidate));
        if (root !== null) {
          break;
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    const key = root ?? real(candidates[1]!) ?? candidates[1]!;
    const existing = found.get(key);
    if (existing !== undefined) {
      existing.roles.push(role);
      continue;
    }
    const identity = known.get(key) ?? { kind: "other" as const, name: basename(key) };
    found.set(key, {
      ...identity,
      path: key,
      reason: root === null ? failure : null,
      roles: [role],
    });
  }
  return [...found.values()].sort((left, right) => (left.name < right.name ? -1 : 1));
}

function userSource(request: RequestRecord): boolean {
  return request.source.origin === "native-user" || /^user\b/i.test(request.source.reference ?? "");
}

function requestEntry(request: RequestRecord): RequestEntry {
  return {
    id: request.id,
    kind: request.kind,
    owner: request.owner,
    question: request.question,
    reason: request.reason,
    requiredOwner: request.requiredOwner,
    state: request.closed === null ? request.state : "closed",
    updatedAt: request.updatedAt,
    userSource: userSource(request),
  };
}

/** The work IDs a request names: its own list and, once closed, the work its owner named. */
function requestWork(request: RequestRecord): string[] {
  return [...request.work, ...(request.closed?.work == null ? [] : [request.closed.work])];
}

function latest(times: readonly (string | null | undefined)[]): string | null {
  let best: number | null = null;
  for (const time of times) {
    const value = time === null || time === undefined ? Number.NaN : Date.parse(time);
    if (!Number.isNaN(value) && (best === null || value > best)) {
      best = value;
    }
  }
  return best === null ? null : new Date(best).toISOString();
}

function gitDeployment(point: DeployPoint, matched: GitDeployment["matched"]): GitDeployment {
  return { at: point.at, matched, sha: point.sha, tag: point.tag, via: point.via };
}

function coveringTime(deployed: GitDeployment | null, citation: Landing | null): string | null {
  return deployed?.via === "last-deploy" &&
    deployed.matched === "landing" &&
    deployed.sha !== citation?.sha
    ? null
    : (deployed?.at ?? null);
}

/** Blocker and owner from a blocked or waiting linked request. */
function blockage(requests: readonly RequestEntry[]): {
  blocker: string | null;
  owner: string | null;
  blocked: boolean;
} {
  const request = requests.find((entry) => entry.state === "blocked" || entry.state === "waiting");
  if (request !== undefined) {
    return { blocked: true, blocker: request.reason, owner: request.requiredOwner };
  }
  return { blocked: false, blocker: null, owner: null };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

interface RepositoryItems {
  readonly status: RepositoryStatus;
  readonly items: StatusItem[];
  readonly linked: Set<string>;
}

function readRepository(
  context: StatusContext,
  layout: Layout,
  repository: Repository,
  storeWork: StoreWorkSnapshot,
  verifySince: string,
): RepositoryItems {
  const channel: DeploymentChannel =
    repository.kind === "game" ? "bus" : repository.kind === "kit" ? "release-tag" : "none";
  const base: RepositoryStatus = {
    deployment: {
      channel,
      status: channel === "none" ? "not-applicable" : "unavailable",
      unreadable: 0,
    },
    kind: repository.kind,
    main: null,
    name: repository.name,
    originMain: null,
    path: repository.path,
    reason: repository.reason,
    roles: repository.roles,
    status: "unavailable",
  };
  const linked = new Set<string>();
  if (repository.reason !== null) {
    return { items: [], linked, status: base };
  }
  let history;
  let files;
  let doneAt;
  let statusAt;
  try {
    history = readHistory(context.git, repository.path);
    ({ doneAt, files, statusAt } = readMainFiles(context.git, repository.path, WORK_DIRECTORY));
  } catch (error) {
    return {
      items: [],
      linked,
      status: { ...base, reason: error instanceof Error ? error.message : String(error) },
    };
  }
  const onMain = reachable(history, history.main);
  const onOrigin = history.originMain === null ? null : reachable(history, history.originMain);
  let points: readonly DeployPoint[] = [];
  let deployment: RepositoryStatus["deployment"] = base.deployment;
  if (channel === "bus") {
    const stored = storeWork.deployments.get(repository.name) ?? [];
    points = stored;
    try {
      const bus = readBusDeployments(gameLayout(layout, repository.name).busDir);
      points = [...stored, ...bus.points];
      deployment = {
        channel,
        status: stored.length > 0 ? "available" : bus.status,
        unreadable: bus.unreadable,
      };
    } catch {
      deployment = { channel, status: "unavailable", unreadable: 0 };
    }
  } else if (channel === "release-tag") {
    points = releasePoints(history);
    deployment = { channel, status: "available", unreadable: 0 };
  }
  const reachablePoints = points.filter(
    ({ sha }) => onMain.has(sha) || onOrigin?.has(sha) === true,
  );
  const marks = deploymentMarks(history, reachablePoints);
  const listed = workListings(reachablePoints);
  const workFiles = [...files.values()]
    .filter((file) => {
      const name = file.path.slice(WORK_DIRECTORY.length + 1);
      return !name.includes("/") && name.endsWith(".md") && name !== CONVENTION_FILE;
    })
    .sort((left, right) => (left.path < right.path ? -1 : 1))
    .map((file) => {
      const fields = parseFrontMatter(file.text)?.fields ?? {};
      return {
        approved: text(fields.approved),
        design: text(fields.design),
        file,
        id: text(fields.id) ?? basename(file.path, ".md"),
        status: text(fields.status),
        supersedes: fieldIds(fields.supersedes),
        title: text(fields.title),
      };
    });
  const { addedIn, landing } = findLandings(
    history,
    onMain,
    workFiles.map((work) => ({ id: work.id, path: work.file.path, title: work.title })),
    doneAt,
  );
  const supersededBy = new Map<string, string>();
  const workById = new Map(workFiles.map((work) => [work.id, work]));
  for (const work of workFiles) {
    if (!["proposed", "declined", "cancelled"].includes(work.status ?? "proposed")) {
      for (const id of work.supersedes) {
        supersededBy.set(id, work.id);
      }
    }
  }
  const items: StatusItem[] = [];
  for (const work of workFiles) {
    const linkedRequests = [...storeWork.requests.values()].filter(
      (request) => request.id === work.id || requestWork(request).includes(work.id),
    );
    linkedRequests.forEach((request) => linked.add(request.id));
    const requests = linkedRequests
      .sort((left, right) => (left.id < right.id ? -1 : 1))
      .map(requestEntry);
    const land = landing.get(work.id) ?? null;
    const covering = land === null ? undefined : marks.get(land.sha);
    const confirmedLanding = land?.rule === "done-flip";
    const confirmedCoverage = confirmedLanding ? covering : undefined;
    const listing = listed.get(work.id);
    const deployed =
      listing !== undefined &&
      (confirmedCoverage === undefined || listing.order < confirmedCoverage.order)
        ? gitDeployment(listing, "work-list")
        : confirmedCoverage === undefined
          ? null
          : gitDeployment(confirmedCoverage, "landing");
    const heuristicDeployment =
      confirmedLanding || covering === undefined ? null : gitDeployment(covering, "landing");
    const record = storeWork.records.get(`${repository.name}\n${work.id}`) ?? null;
    const storeLanded = record?.evidence.some((item) => item.stage === "merged") === true;
    const storeDeployed =
      record?.evidence.some(
        (item) =>
          item.stage === "deployed" || (channel === "release-tag" && item.stage === "published"),
      ) === true;
    const replacement = supersededBy.get(work.id) ?? null;
    const derived = deriveWorkFile({
      channel,
      deployed: storeDeployed || deployed !== null,
      doneAt: doneAt.get(work.file.path)?.at ?? work.file.at,
      frontMatter: work.status,
      landed: storeLanded || confirmedLanding,
      started:
        record?.startedAt != null ||
        requests.some((request) => ACTIVE_LEDGER_STATES.has(request.state as never)),
      supersededBy: replacement,
      verifySince,
    });
    const block = CLOSED.has(derived.status)
      ? { blocked: false, blocker: null, owner: null }
      : record?.block != null
        ? { blocked: true, blocker: record.block.reason, owner: record.block.owner }
        : blockage(requests);
    const replacementWork = replacement === null ? undefined : workById.get(replacement);
    const completedAt = !CLOSED.has(derived.status)
      ? null
      : latest([
          replacementWork === undefined
            ? statusAt.get(work.file.path)?.at
            : statusAt.get(replacementWork.file.path)?.at,
          record?.finishedAt,
        ]);
    items.push({
      ...block,
      completedAt,
      delivery: {
        deployed,
        heuristicDeployment,
        landing: land,
        onOrigin: land === null || onOrigin === null ? null : onOrigin.has(land.sha),
      },
      deliveryEvidence: derived.deliveryEvidence,
      deliverySource: {
        deployment: storeDeployed ? "store" : deployed === null ? null : "git",
        landing: storeLanded ? "store" : confirmedLanding ? "git" : null,
      },
      deliveryVerified: derived.deliveryVerified,
      id: work.id,
      // The item's own activity: a closed item's file edits after it closed (such as bulk
      // front-matter updates) are not activity, and a `last-deploy` point stands for every older
      // commit it contains, so its time counts only for the commit it names.
      latestEvidenceAt: latest([
        CLOSED.has(derived.status) ? completedAt : work.file.at,
        confirmedLanding ? land.at : null,
        coveringTime(deployed, land),
        record?.updatedAt,
        ...linkedRequests.map((request) => request.closed?.at ?? request.updatedAt),
      ]),
      replacement: derived.replacement,
      repository: repository.name,
      requests,
      status: derived.status,
      store: record,
      title: work.title,
      userOriginated:
        /^user\b/i.test(work.approved ?? "") || requests.some((request) => request.userSource),
      waitingOnUser:
        derived.status === "proposed" || requests.some((request) => request.question === "pending"),
      workFile: {
        addedIn: addedIn.get(work.id) ?? null,
        approved: work.approved,
        commit: work.file.commit,
        committedAt: work.file.at,
        design: work.design,
        path: work.file.path,
        status: work.status,
        supersedes: work.supersedes,
      },
    });
  }
  return {
    items,
    linked,
    status: {
      ...base,
      deployment,
      main: history.main,
      originMain: history.originMain,
      reason: null,
      status: "available",
    },
  };
}

/** Open imported requests that no work file names: `requested` items of their owner's repository. */
function requestedItems(
  requests: readonly RequestRecord[],
  repositoryOf: (role: string) => string | null,
): StatusItem[] {
  const items: StatusItem[] = [];
  for (const request of requests) {
    if (request.closed !== null) {
      continue;
    }
    const repository = repositoryOf(request.owner);
    if (repository === null) {
      continue;
    }
    const entry = requestEntry(request);
    items.push({
      ...blockage([entry]),
      completedAt: null,
      delivery: { deployed: null, heuristicDeployment: null, landing: null, onOrigin: null },
      deliveryEvidence: null,
      deliverySource: { deployment: null, landing: null },
      deliveryVerified: null,
      id: request.id,
      latestEvidenceAt: latest([request.updatedAt]),
      replacement: null,
      repository,
      requests: [entry],
      status: "requested",
      store: null,
      title: request.summary,
      userOriginated: entry.userSource,
      waitingOnUser: entry.question === "pending",
      workFile: null,
    });
  }
  return items;
}

/** Preserve work records when a repository or its current work file cannot be read. */
function recordOnlyItem(record: WorkRecord): StatusItem {
  const block = record.state === "finished" ? null : record.block;
  const merged = record.evidence.some(({ stage }) => stage === "merged");
  const deployed = record.evidence.some(({ stage }) => stage === "deployed");
  return {
    blocked: block !== null,
    blocker: block?.reason ?? null,
    completedAt: record.finishedAt,
    delivery: { deployed: null, heuristicDeployment: null, landing: null, onOrigin: null },
    deliveryEvidence: deployed ? "deployed" : null,
    deliverySource: { deployment: deployed ? "store" : null, landing: merged ? "store" : null },
    deliveryVerified: deployed ? true : null,
    id: record.id,
    latestEvidenceAt: latest([record.updatedAt]),
    owner: block?.owner ?? null,
    replacement: null,
    repository: record.repository,
    requests: [],
    status:
      record.state === "finished"
        ? "done"
        : deployed
          ? "deployed"
          : merged
            ? "landed"
            : record.startedAt === null
              ? "requested"
              : "in-progress",
    store: record,
    title: null,
    userOriginated: false,
    waitingOnUser: false,
    workFile: null,
  };
}

/** The selected repositories and, for a role scope, the role whose items are kept. */
function selectScope(
  layout: Layout,
  registry: Registry,
  repos: readonly Repository[],
  scope: string,
): { names: Set<string>; role: string | null } {
  if (scope === "all") {
    return { names: new Set(repos.map((repo) => repo.name)), role: null };
  }
  if (Object.hasOwn(layout.config.games, scope) || Object.hasOwn(layout.config.kits, scope)) {
    return {
      names: new Set(repos.filter((repo) => repo.name === scope).map((r) => r.name)),
      role: null,
    };
  }
  if (Object.hasOwn(registry.roles, scope)) {
    const repo = repos.find((candidate) => candidate.roles.includes(scope));
    return { names: new Set(repo === undefined ? [] : [repo.name]), role: scope };
  }
  throw new StatusUsageError(`--scope names no game, kit or registered role: ${scope}`);
}

/** A role scope keeps items that role owns in the store or designs (games' areas). */
function ownedBy(role: string, item: StatusItem): boolean {
  const area = role.includes("/") ? role.split("/")[1] : null;
  return (
    item.requests.some((request) => request.owner === role) ||
    item.store?.owner === role ||
    (area !== null && item.workFile?.design === area)
  );
}

/** Collect, derive and filter the status of every selected repository's items. */
export function collectStatus(
  context: StatusContext,
  coordinatorRoot: string,
  options: StatusOptions,
): StatusReport {
  const layout = loadLayout(coordinatorRoot);
  const registry = readRegistry(layout);
  const repos = repositories(context, layout, registry);
  const selected = selectScope(layout, registry, repos, options.scope);
  const storeWork = readStoreWork(layout);
  const reports = repos
    .filter((repo) => selected.names.has(repo.name))
    .map((repo) => readRepository(context, layout, repo, storeWork, options.verifySince));
  const linked = new Set(reports.flatMap((report) => [...report.linked]));
  const coordinator = repos.find((repo) => repo.kind === "coordinator")?.name ?? null;
  const repositoriesByRole = new Map(
    repos.flatMap((repo) => repo.roles.map((role) => [role, repo.name])),
  );
  const namedRepository = (role: string): string | null => repositoriesByRole.get(role) ?? null;
  const repositoryOf = (role: string): string | null => {
    const name = namedRepository(role) ?? coordinator;
    return name !== null && selected.names.has(name) ? name : null;
  };
  const inScope = (role: string) =>
    options.scope === "all" ||
    (selected.role === null ? repositoryOf(role) !== null : selected.role === role);
  const since = options.since === null ? null : Date.parse(options.since);
  const recent = (at: string | null): at is string =>
    at !== null && (since === null || Date.parse(at) >= since);
  const unmatched = [...storeWork.requests.values()]
    .filter(
      (request) =>
        !linked.has(request.id) &&
        inScope(request.owner) &&
        (request.closed === null || recent(request.closed.at)) &&
        (!options.audit || userSource(request)),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const unmatchedRequests = unmatched.map((request): UnmatchedRequest => ({
    ...requestEntry(request),
    closedAt: request.closed?.at ?? null,
    repository: namedRepository(request.owner),
    summary: request.summary,
    work: requestWork(request),
  }));
  const questions = storeWork.questions.filter((question) => inScope(question.role));
  const pendingQuestions = questions.filter(({ state }) => state === "pending");
  const activeHolds = storeWork.holds.filter(
    (hold) =>
      options.scope === "all" ||
      (hold.role !== null && inScope(hold.role)) ||
      (hold.scope.startsWith("game:") && selected.names.has(hold.scope.slice(5))) ||
      (hold.source === "approval-ledger" &&
        hold.scope
          .slice(5)
          .split(",")
          .some((ref) => selected.names.has(ref.split(":")[0]!))),
  );
  const workItems = reports.flatMap((report) => report.items);
  const workKeys = new Set(workItems.map((item) => `${item.repository}\n${item.id}`));
  const recordsWithoutFiles = [...storeWork.records.values()]
    .filter(
      (record) =>
        (options.scope === "all" || selected.names.has(record.repository)) &&
        !workKeys.has(`${record.repository}\n${record.id}`),
    )
    .map(recordOnlyItem);
  const questionsByItem = new Map<string, QuestionView[]>();
  for (const question of questions) {
    const repository = namedRepository(question.role);
    if (repository !== null && question.work !== null) {
      const key = `${repository}\n${question.work}`;
      const belonging = questionsByItem.get(key) ?? [];
      belonging.push(question);
      questionsByItem.set(key, belonging);
    }
  }
  let items = [
    ...workItems,
    ...recordsWithoutFiles,
    ...requestedItems(unmatched, repositoryOf),
  ].map((item) => {
    const belonging = questionsByItem.get(`${item.repository}\n${item.id}`);
    return belonging === undefined
      ? item
      : {
          ...item,
          latestEvidenceAt: latest([
            item.latestEvidenceAt,
            ...belonging.map(({ closedAt, openedAt }) => closedAt ?? openedAt),
          ]),
          waitingOnUser: item.waitingOnUser || belonging.some(({ state }) => state === "pending"),
        };
  });
  if (selected.role !== null) {
    items = items.filter((item) => ownedBy(selected.role!, item));
  }
  if (options.states.length > 0) {
    items = items.filter(
      (item) =>
        options.states.includes(item.status) ||
        (options.states.includes("unverified") && item.deliveryVerified === false),
    );
  }
  if (options.audit) {
    items = items.filter((item) => item.userOriginated);
  }
  const order = new Map(repos.map((repo, index) => [repo.name, index]));
  items.sort(
    (left, right) =>
      (order.get(left.repository) ?? repos.length) -
        (order.get(right.repository) ?? repos.length) ||
      left.repository.localeCompare(right.repository) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  const timed = (field: "latestEvidenceAt" | "completedAt") =>
    items
      .flatMap((item) => {
        const at = item[field];
        return recent(at) ? [{ at, id: item.id, repository: item.repository }] : [];
      })
      .sort((left, right) => right.at.localeCompare(left.at));
  return {
    activeHolds,
    coordinator: {
      root: layout.root,
      store: storeWork.state,
    },
    filters: options,
    items: items.filter((item) => !CLOSED.has(item.status) || recent(item.latestEvidenceAt)),
    pendingQuestions,
    recentActivity: timed("latestEvidenceAt"),
    recentCompletions: timed("completedAt"),
    repositories: reports.map((report) => report.status),
    schema: STATUS_SCHEMA,
    unmatchedRequests,
  };
}

/** True when any source or selected repository could not be read; the command then exits 1. */
export function incomplete(report: StatusReport): boolean {
  return (
    report.coordinator.store.status === "unavailable" ||
    report.repositories.some(
      (repo) =>
        repo.status === "unavailable" ||
        repo.deployment.status === "unavailable" ||
        repo.deployment.unreadable > 0,
    )
  );
}
