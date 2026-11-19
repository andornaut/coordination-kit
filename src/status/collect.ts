// `coordination-kit status`: every registered repository's work items joined with live protocol
// state, linked ledger requests and delivery evidence, one derived status per item. Read-only:
// one history pass and one work-file pass per repository, and one read of the coordinator state.
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

import type { LedgerRequest } from "../accounting/types.ts";
import type { Io } from "../io.ts";
import { gameLayout, type Layout, loadLayout } from "../layout.ts";
import { protocolRole } from "../protocol/core.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { CONVENTION_FILE, parseFrontMatter } from "../work/files.ts";
import {
  deploymentMarks,
  type DeployPoint,
  findLandings,
  type Landing,
  reachable,
  readCompleteEvents,
  releasePoints,
} from "./delivery.ts";
import {
  ACTIVE_LEDGER_STATES,
  CLOSED,
  type DeploymentChannel,
  type DerivedStatus,
  deriveLedgerOnly,
  deriveWorkFile,
} from "./derive.ts";
import { type GitRunner, readHistory, readMainFiles, repositoryRoot } from "./git.ts";
import {
  type LedgerSnapshot,
  type ProtocolSnapshot,
  type PublicationRecord,
  readLedger,
  readProtocol,
  type SourceCounters,
} from "./sources.ts";

export const STATUS_SCHEMA = 1;
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
  readonly states: readonly DerivedStatus[];
  readonly audit: boolean;
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

export interface ProtocolEntry {
  readonly role: string;
  readonly joinedBy: readonly ("id" | "path")[];
  readonly revision: number;
  readonly ready: boolean;
  readonly accepted: number;
  readonly receipts: number;
  readonly criteriaSatisfied: boolean | null;
  readonly authorization: "reviewed" | "unknown" | null;
  readonly historicallyClosed: boolean | null;
  readonly guarded: boolean | null;
  /** The work-reference half of the before-work admission: reviewed and unguarded. */
  readonly beforeWork: "admissible" | "refused" | null;
  readonly retention: {
    readonly owner: string;
    readonly reason: string;
    readonly nextBoundary: string;
  } | null;
  readonly workers: PublicationRecord["workers"];
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
  readonly latestEvidenceAt: string | null;
  readonly workFile: {
    readonly path: string;
    readonly status: string | null;
    readonly approved: string | null;
    readonly design: string | null;
    readonly supersedes: string | null;
    readonly addedIn: string | null;
    readonly commit: string;
    readonly committedAt: string;
  } | null;
  /** Null when the protocol state is unconfigured or unavailable. */
  readonly protocol: readonly ProtocolEntry[] | null;
  readonly requests: readonly RequestEntry[];
  readonly delivery: {
    readonly landing: Landing | null;
    readonly onOrigin: boolean | null;
    readonly deployed: {
      readonly sha: string;
      readonly at: string;
      readonly via: DeployPoint["via"];
      readonly tag: string | null;
    } | null;
  };
}

export interface StatusReport {
  readonly schema: typeof STATUS_SCHEMA;
  readonly coordinator: {
    readonly root: string;
    readonly protocol: ProtocolSnapshot["state"];
    readonly ledger: LedgerSnapshot["state"];
  };
  readonly filters: StatusOptions;
  readonly repositories: readonly RepositoryStatus[];
  readonly items: readonly StatusItem[];
}

export interface StatusContext {
  readonly io: Pick<Io, "env">;
  readonly git: GitRunner;
  readonly counters: SourceCounters;
}

interface Repository {
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
function repositories(context: StatusContext, layout: Layout, registry: Registry): Repository[] {
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

function requestOwner(request: LedgerRequest): string {
  return request.assignment?.ownerRole ?? request.createdBy;
}

function userSource(request: LedgerRequest): boolean {
  return [request.source, ...request.sources.map((link) => link.source)].some(
    (source) => source.origin === "native-user" || /^user\b/i.test(source.reference ?? ""),
  );
}

function requestEntry(request: LedgerRequest): RequestEntry {
  return {
    id: request.id,
    kind: request.kind,
    owner: requestOwner(request),
    question: request.question?.status ?? null,
    reason: request.reason,
    requiredOwner: request.requiredOwner,
    state: request.state,
    updatedAt: request.updatedAt,
    userSource: userSource(request),
  };
}

function protocolEntry(record: PublicationRecord, joinedBy: ("id" | "path")[]): ProtocolEntry {
  const { evaluation, publication } = record;
  return {
    accepted: publication.accepted.length,
    authorization: evaluation?.authorization ?? null,
    beforeWork:
      evaluation === null
        ? null
        : evaluation.authorization === "reviewed" && !evaluation.guarded
          ? "admissible"
          : "refused",
    criteriaSatisfied: evaluation?.criteriaSatisfied ?? null,
    guarded: evaluation?.guarded ?? null,
    historicallyClosed: evaluation?.historicallyClosed ?? null,
    joinedBy,
    ready: publication.ready,
    receipts: publication.receipts.length,
    retention: publication.definition.retention,
    revision: record.revision,
    role: record.role,
    workers: record.workers,
  };
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

/** Blocker and owner from a blocked or waiting linked request, else from a protocol retention. */
function blockage(
  requests: readonly RequestEntry[],
  protocol: readonly ProtocolEntry[],
): { blocker: string | null; owner: string | null; blocked: boolean } {
  const request = requests.find((entry) => entry.state === "blocked" || entry.state === "waiting");
  if (request !== undefined) {
    return { blocked: true, blocker: request.reason, owner: request.requiredOwner };
  }
  const retained = protocol.find((entry) => entry.retention !== null)?.retention;
  if (retained !== undefined && retained !== null) {
    return { blocked: true, blocker: retained.reason, owner: retained.owner };
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
  protocol: ProtocolSnapshot,
  ledger: LedgerSnapshot,
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
  try {
    history = readHistory(context.git, repository.path);
    files = readMainFiles(context.git, repository.path, WORK_DIRECTORY);
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
    try {
      const bus = readCompleteEvents(gameLayout(layout, repository.name).busDir);
      points = bus.points;
      deployment = { channel, status: bus.status, unreadable: bus.unreadable };
    } catch {
      deployment = { channel, status: "unavailable", unreadable: 0 };
    }
  } else if (channel === "release-tag") {
    points = releasePoints(history);
    deployment = { channel, status: "available", unreadable: 0 };
  }
  const marks = deploymentMarks(history, points);
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
        supersedes: text(fields.supersedes),
        title: text(fields.title),
      };
    });
  const { addedIn, landing } = findLandings(
    history,
    onMain,
    workFiles.map((work) => ({ id: work.id, path: work.file.path, title: work.title })),
  );
  const supersededBy = new Map<string, string>();
  for (const work of workFiles) {
    if (
      work.supersedes !== null &&
      !["proposed", "declined", "cancelled"].includes(work.status ?? "proposed")
    ) {
      supersededBy.set(work.supersedes, work.id);
    }
  }
  const namespaces = new Set(repository.roles.map((role) => protocolRole(role)));
  const items: StatusItem[] = [];
  for (const work of workFiles) {
    const joined: ProtocolEntry[] = [];
    for (const namespace of [...namespaces].sort()) {
      for (const record of protocol.publications.get(namespace) ?? []) {
        const by: ("id" | "path")[] = [];
        if (record.id === work.id) {
          by.push("id");
        }
        if (record.publication.definition.plan.path === work.file.path) {
          by.push("path");
        }
        if (by.length > 0) {
          joined.push(protocolEntry(record, by));
        }
      }
    }
    const requestIds = new Set<string>();
    for (const namespace of namespaces) {
      for (const record of protocol.publications.get(namespace) ?? []) {
        if (record.id === work.id || record.publication.definition.plan.path === work.file.path) {
          record.publication.definition.requestIds.forEach((id) => requestIds.add(id));
        }
      }
    }
    if (ledger.requests.has(work.id)) {
      requestIds.add(work.id);
    }
    requestIds.forEach((id) => linked.add(id));
    const requests = [...requestIds].sort().flatMap((id) => {
      const request = ledger.requests.get(id);
      return request === undefined ? [] : [requestEntry(request)];
    });
    const land = landing.get(work.id) ?? null;
    const mark = land === null ? undefined : marks.get(land.sha);
    const deployed =
      mark === undefined ? null : { at: mark.at, sha: mark.sha, tag: mark.tag, via: mark.via };
    const derived = deriveWorkFile({
      channel,
      deployed: deployed !== null,
      frontMatter: work.status,
      landed: land !== null,
      started:
        joined.length > 0 ||
        requests.some((request) => ACTIVE_LEDGER_STATES.has(request.state as never)),
      supersededBy: supersededBy.get(work.id) ?? null,
    });
    const block = CLOSED.has(derived.status)
      ? { blocked: false, blocker: null, owner: null }
      : blockage(requests, joined);
    items.push({
      ...block,
      delivery: {
        deployed,
        landing: land,
        onOrigin: land === null || onOrigin === null ? null : onOrigin.has(land.sha),
      },
      id: work.id,
      latestEvidenceAt: latest([
        work.file.at,
        land?.at,
        deployed?.at,
        ...requests.map((request) => request.updatedAt),
      ]),
      protocol:
        protocol.state.status === "available" || protocol.state.status === "partial"
          ? joined
          : null,
      replacement: derived.replacement,
      repository: repository.name,
      requests,
      status: derived.status,
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

/** Ledger requests and approvals that no work publication links (nor any descendant of one). */
function requestedItems(
  ledger: LedgerSnapshot,
  protocol: ProtocolSnapshot,
  linked: ReadonlySet<string>,
  repositoryOf: (role: string) => string | null,
): StatusItem[] {
  const covered = new Set(linked);
  for (const records of protocol.publications.values()) {
    for (const record of records) {
      record.publication.definition.requestIds.forEach((id) => covered.add(id));
    }
  }
  const stack = [...covered];
  while (stack.length > 0) {
    for (const child of ledger.requests.get(stack.pop()!)?.children ?? []) {
      if (!covered.has(child)) {
        covered.add(child);
        stack.push(child);
      }
    }
  }
  const items: StatusItem[] = [];
  for (const request of [...ledger.requests.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (covered.has(request.id) || !["request", "approval"].includes(request.kind)) {
      continue;
    }
    const repository = repositoryOf(requestOwner(request));
    if (repository === null) {
      continue;
    }
    const entry = requestEntry(request);
    const derived = deriveLedgerOnly(request.state, request.replacementId);
    const block = CLOSED.has(derived.status)
      ? { blocked: false, blocker: null, owner: null }
      : blockage([entry], []);
    items.push({
      ...block,
      delivery: { deployed: null, landing: null, onOrigin: null },
      id: request.id,
      latestEvidenceAt: latest([request.updatedAt]),
      protocol: null,
      replacement: derived.replacement,
      repository,
      requests: [entry],
      status: derived.status,
      title: request.summary,
      userOriginated: entry.userSource,
      waitingOnUser: entry.question === "pending",
      workFile: null,
    });
  }
  return items;
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

/** A role scope keeps items that role published, owns in the ledger or designs (games' areas). */
function ownedBy(role: string, item: StatusItem): boolean {
  const namespace = protocolRole(role);
  const area = role.includes("/") ? role.split("/")[1] : null;
  return (
    (item.protocol ?? []).some((entry) => entry.role === namespace) ||
    item.requests.some((request) => request.owner === role) ||
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
  const ledger = readLedger(context.io, layout, context.counters);
  const protocol = readProtocol(layout, ledger, context.counters);
  const reports = repos
    .filter((repo) => selected.names.has(repo.name))
    .map((repo) => readRepository(context, layout, repo, protocol, ledger));
  const linked = new Set(reports.flatMap((report) => [...report.linked]));
  const coordinator = repos.find((repo) => repo.kind === "coordinator")?.name ?? null;
  const repositoryOf = (role: string): string | null => {
    const name = repos.find((repo) => repo.roles.includes(role))?.name ?? coordinator;
    return name !== null && selected.names.has(name) ? name : null;
  };
  let items = [
    ...reports.flatMap((report) => report.items),
    ...requestedItems(ledger, protocol, linked, repositoryOf),
  ];
  if (selected.role !== null) {
    items = items.filter((item) => ownedBy(selected.role!, item));
  }
  if (options.states.length > 0) {
    items = items.filter((item) => options.states.includes(item.status));
  }
  if (options.since !== null) {
    const since = Date.parse(options.since);
    items = items.filter(
      (item) => item.latestEvidenceAt !== null && Date.parse(item.latestEvidenceAt) >= since,
    );
  }
  if (options.audit) {
    items = items.filter((item) => item.userOriginated);
  }
  const order = new Map(repos.map((repo, index) => [repo.name, index]));
  items.sort(
    (left, right) =>
      (order.get(left.repository) ?? 0) - (order.get(right.repository) ?? 0) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  return {
    coordinator: { ledger: ledger.state, protocol: protocol.state, root: layout.root },
    filters: options,
    items,
    repositories: reports.map((report) => report.status),
    schema: STATUS_SCHEMA,
  };
}

/** True when any source or selected repository could not be read; the command then exits 1. */
export function incomplete(report: StatusReport): boolean {
  return (
    report.coordinator.ledger.status === "unavailable" ||
    report.coordinator.protocol.status === "unavailable" ||
    report.coordinator.protocol.status === "partial" ||
    report.repositories.some(
      (repo) =>
        repo.status === "unavailable" ||
        repo.deployment.status === "unavailable" ||
        repo.deployment.unreadable > 0,
    )
  );
}
