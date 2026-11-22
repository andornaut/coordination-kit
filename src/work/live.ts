// The work verbs as the CLI runs them: resolve the repository from --root and the registry, read
// the work file from the repository's local `main`, resolve the item's owner, check the caller
// through the registry fence, then apply one store write. Only the owner may write.
import { realpathSync } from "node:fs";

import { type Layout, loadLayout } from "../layout.ts";
import type { Registry } from "../registry/schema.ts";
import { readRegistry } from "../registry/store.ts";
import { StateRootError } from "../stateRoot.ts";
import { repositories, type Repository } from "../status/collect.ts";
import { type GitRunner, repositoryRoot } from "../status/git.ts";
import { MEMORY, Store } from "../store/db.ts";
import { fileWorkerCaller } from "../store/files/workerAccess.ts";
import { type CallerOptions, resolveCaller } from "../store/identity.ts";
import { listDecisions, storeHolds } from "../store/questions.ts";
import { type Actor, StoreError } from "../store/types.ts";
import {
  blockWork,
  checkRef,
  type CoveringHold,
  finishWork,
  type HoldCover,
  type HoldLookup,
  readWorkRecord,
  readyWork,
  recordEvidence,
  startWork,
  unblockWork,
  workHistory,
  type WorkHistoryEntry,
  type WorkRecord,
  type WorkRef,
  type WorkStage,
  type WorkWrite,
} from "../store/work.ts";
import { parseDecisions } from "./decisions.ts";
import { type FrontMatterValue, parseFrontMatter, readWorkFiles } from "./files.ts";

export interface Coordinator {
  readonly layout: Layout;
  readonly registry: Registry;
  readonly repositories: readonly Repository[];
}

export interface LiveContext {
  readonly env: NodeJS.ProcessEnv;
  readonly git: GitRunner;
  /** The coordinator root, from COORDINATION_KIT_ROOT or DELIVERY_KIT_ROOT only. */
  readonly coordinatorRoot: string | undefined;
  /** The open holds covering an item; defaults to the store's hold records. */
  readonly holds?: HoldLookup;
  /** Test hook: the store clock. */
  readonly now?: () => string;
}

export function openCoordinator(git: GitRunner, root: string | undefined): Coordinator {
  if (root === undefined) {
    throw new StoreError("coordinator-unset");
  }
  let layout: Layout;
  let registry: Registry;
  try {
    layout = loadLayout(root);
    registry = readRegistry(layout);
  } catch {
    throw new StoreError("registry-unavailable");
  }
  return { layout, registry, repositories: repositories({ git }, layout, registry) };
}

/** The registered repository that holds `worktree`. */
export function repositoryAt(
  git: GitRunner,
  coordinator: Coordinator,
  worktree: string,
): Repository {
  let path: string;
  try {
    path = realpathSync(repositoryRoot(git, worktree));
  } catch {
    throw new StoreError("repository-unavailable");
  }
  const found = coordinator.repositories.find((repository) => repository.path === path);
  if (found === undefined || found.reason !== null) {
    throw new StoreError("repository-unregistered");
  }
  return found;
}

export function repositoryNamed(coordinator: Coordinator, name: string): Repository {
  const found = coordinator.repositories.find((repository) => repository.name === name);
  if (found === undefined) {
    throw new StoreError("repository-unregistered");
  }
  return found;
}

export interface MainWorkFile {
  readonly path: string;
  readonly fields: Readonly<Record<string, FrontMatterValue>>;
  readonly text: string;
  readonly status: string | null;
  readonly title: string | null;
}

/** `docs/work/<id>.md` as committed on the repository's local `main`, or null when absent. */
export function readMainWorkFile(
  git: GitRunner,
  repository: Repository,
  id: string,
): MainWorkFile | null {
  const path = `docs/work/${id}.md`;
  let text: string;
  try {
    text = git(repository.path, ["show", `refs/heads/main:${path}`]);
  } catch {
    return null;
  }
  const fields = parseFrontMatter(text)?.fields ?? {};
  const value = (key: string) => (typeof fields[key] === "string" ? fields[key] : null);
  if (value("id") !== id) {
    return null;
  }
  return { fields, path, status: value("status"), text, title: value("title") };
}

/**
 * The role that owns a work item: its front-matter `owner`; else the repository's only role; else,
 * in a game, the role named by the item's `design` area (`<game>/<area>`), then the game's Tech.
 * Null when none applies. The owner must be one of the repository's roles.
 */
export function workOwner(
  repository: Repository,
  fields: Readonly<Record<string, FrontMatterValue>>,
): string | null {
  const owner = fields.owner;
  if (typeof owner === "string" && owner !== "") {
    return repository.roles.includes(owner) ? owner : null;
  }
  if (repository.roles.length === 1) {
    return repository.roles[0]!;
  }
  if (repository.kind === "game") {
    const design = typeof fields.design === "string" ? fields.design : "";
    for (const candidate of [`${repository.name}/${design}`, `${repository.name}/tech`]) {
      if (repository.roles.includes(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

interface Target {
  readonly coordinator: Coordinator;
  readonly repository: Repository;
  readonly file: MainWorkFile;
  readonly ref: WorkRef;
  readonly owner: string;
}

/** A hold covers an item through its owner role, and through its game for a game repository. */
function holdCover(at: Target): HoldCover {
  return { game: at.repository.kind === "game" ? at.repository.name : null, owner: at.owner };
}

function target(context: LiveContext, worktree: string, id: string): Target {
  const coordinator = openCoordinator(context.git, context.coordinatorRoot);
  const repository = repositoryAt(context.git, coordinator, worktree);
  const ref = checkRef({ id, repository: repository.name });
  const file = readMainWorkFile(context.git, repository, id);
  if (file === null) {
    throw new StoreError("work-file-missing");
  }
  const owner = workOwner(repository, file.fields);
  if (owner === null) {
    throw new StoreError("owner-unresolved");
  }
  return { coordinator, file, owner, ref, repository };
}

/** The fenced caller, who must be the item's owner. */
function ownerActor(
  context: LiveContext,
  at: Target,
  options: CallerOptions,
  worker: "start" | "started" | "none" = "none",
): Actor {
  const { layout, registry } = at.coordinator;
  const workerProof =
    worker === "none"
      ? undefined
      : fileWorkerCaller(
          layout,
          registry,
          context.now ?? (() => new Date().toISOString()),
          (index, nativeId) =>
            worker === "start" ||
            index
              .prepare(
                `SELECT 1 FROM events WHERE kind = 'work.started' AND actor_native_id = ?
           AND json_extract(payload, '$.repository') = ? AND json_extract(payload, '$.id') = ?`,
              )
              .get(nativeId, at.ref.repository, at.ref.id) !== undefined,
        );
  const actor = resolveCaller(registry, context.env, options, workerProof);
  if (actor.role !== at.owner) {
    throw new StoreError("not-owner");
  }
  return actor;
}

function withStore<T>(
  context: LiveContext,
  layout: Layout,
  body: (store: Store) => T,
  createMissing = true,
): T {
  let store: Store;
  try {
    store = createMissing
      ? Store.forLayout(layout, context.now === undefined ? {} : { now: context.now })
      : (Store.readLayout(layout) ?? Store.open(MEMORY));
  } catch (error) {
    if (error instanceof StateRootError) {
      throw new StoreError("store-unavailable");
    }
    throw error;
  }
  try {
    return body(store);
  } finally {
    store.close();
  }
}

export interface WorkOutput {
  readonly schema: 1;
  readonly repository: string;
  readonly id: string;
  readonly owner: string;
  readonly workFile: { readonly path: string; readonly status: string | null };
  readonly duplicate: boolean;
  readonly record: WorkRecord;
}

function output(at: Target, written: WorkWrite): WorkOutput {
  return {
    duplicate: written.duplicate,
    id: at.ref.id,
    owner: at.owner,
    record: written.record,
    repository: at.ref.repository,
    schema: 1,
    workFile: { path: at.file.path, status: at.file.status },
  };
}

function requireStatus(at: Target, statuses: readonly string[], code: string): void {
  if (!statuses.includes(at.file.status ?? "")) {
    throw new StoreError(code);
  }
}

/** `<repository>:<id>`. */
export function parseWorkRef(value: string): WorkRef {
  const at = value.lastIndexOf(":");
  if (at <= 0) {
    throw new StoreError("invalid-parent");
  }
  return checkRef({ id: value.slice(at + 1), repository: value.slice(0, at) });
}

export function workStart(
  context: LiveContext,
  options: CallerOptions,
  input: { readonly worktree: string; readonly id: string; readonly parent?: string },
): WorkOutput {
  const at = target(context, input.worktree, input.id);
  const actor = ownerActor(context, at, options, input.parent === undefined ? "none" : "start");
  requireStatus(at, ["approved"], "work-not-approved");
  let parent: WorkRef | null = null;
  if (input.parent !== undefined) {
    parent = parseWorkRef(input.parent);
    const repository = repositoryNamed(at.coordinator, parent.repository);
    if (readMainWorkFile(context.git, repository, parent.id) === null) {
      throw new StoreError("parent-missing");
    }
  }
  return withStore(context, at.coordinator.layout, (store) =>
    store.transaction(() => {
      const holds = (context.holds ?? storeHolds)(store, at.ref, holdCover(at));
      if (holds.length > 0) {
        throw new StoreError("work-held");
      }
      return output(at, startWork(store, actor, { owner: at.owner, parent, ref: at.ref }));
    }),
  );
}

export function workEvidence(
  context: LiveContext,
  options: CallerOptions,
  input: {
    readonly worktree: string;
    readonly id: string;
    readonly stage: WorkStage;
    readonly sha: string;
    readonly ref?: string;
  },
): WorkOutput {
  const at = target(context, input.worktree, input.id);
  const actor = ownerActor(
    context,
    at,
    options,
    input.stage === "implemented" ? "started" : "none",
  );
  requireStatus(at, ["approved", "done"], "work-not-approved");
  return withStore(context, at.coordinator.layout, (store) =>
    output(
      at,
      recordEvidence(store, actor, {
        evidenceRef: input.ref ?? null,
        ref: at.ref,
        sha: input.sha.toLowerCase(),
        stage: input.stage,
      }),
    ),
  );
}

export function workBlock(
  context: LiveContext,
  options: CallerOptions,
  input: {
    readonly worktree: string;
    readonly id: string;
    readonly reason: string;
    readonly owner?: string;
  },
): WorkOutput {
  const at = target(context, input.worktree, input.id);
  const actor = ownerActor(context, at, options);
  if (input.owner !== undefined && !Object.hasOwn(at.coordinator.registry.roles, input.owner)) {
    throw new StoreError("owner-unregistered");
  }
  return withStore(context, at.coordinator.layout, (store) =>
    output(
      at,
      blockWork(store, actor, { owner: input.owner ?? null, reason: input.reason, ref: at.ref }),
    ),
  );
}

export function workUnblock(
  context: LiveContext,
  options: CallerOptions,
  input: { readonly worktree: string; readonly id: string },
): WorkOutput {
  const at = target(context, input.worktree, input.id);
  const actor = ownerActor(context, at, options);
  return withStore(context, at.coordinator.layout, (store) =>
    output(at, unblockWork(store, actor, { ref: at.ref })),
  );
}

export function workReady(
  context: LiveContext,
  options: CallerOptions,
  input: { readonly worktree: string; readonly id: string },
): WorkOutput {
  const at = target(context, input.worktree, input.id);
  const actor = ownerActor(context, at, options, "started");
  return withStore(context, at.coordinator.layout, (store) =>
    output(at, readyWork(store, actor, { ref: at.ref })),
  );
}

export function workFinish(
  context: LiveContext,
  options: CallerOptions,
  input: { readonly worktree: string; readonly id: string },
): WorkOutput {
  const at = target(context, input.worktree, input.id);
  const actor = ownerActor(context, at, options);
  requireStatus(at, ["done"], "work-not-done");
  return withStore(context, at.coordinator.layout, (store) =>
    output(at, finishWork(store, actor, { owner: at.owner, ref: at.ref })),
  );
}

export interface ShowOutput {
  readonly schema: 1;
  readonly repository: string;
  readonly id: string;
  readonly owner: string;
  readonly workFile: {
    readonly path: string;
    readonly status: string | null;
    readonly title: string | null;
  };
  /** Null when the store has no record of the item. */
  readonly record: WorkRecord | null;
  readonly holds: readonly CoveringHold[];
}

export function workShow(
  context: LiveContext,
  input: { readonly worktree: string; readonly id: string },
): ShowOutput {
  const at = target(context, input.worktree, input.id);
  return withStore(
    context,
    at.coordinator.layout,
    (store) => ({
      holds: (context.holds ?? storeHolds)(store, at.ref, holdCover(at)),
      id: at.ref.id,
      owner: at.owner,
      record: readWorkRecord(store.db, at.ref),
      repository: at.ref.repository,
      schema: 1 as const,
      workFile: { path: at.file.path, status: at.file.status, title: at.file.title },
    }),
    false,
  );
}

export function workHistoryOf(
  context: LiveContext,
  input: { readonly worktree: string; readonly id: string },
): {
  readonly schema: 1;
  readonly repository: string;
  readonly id: string;
  readonly events: readonly WorkHistoryEntry[];
} {
  const at = target(context, input.worktree, input.id);
  return withStore(
    context,
    at.coordinator.layout,
    (store) => ({
      events: workHistory(store, at.ref),
      id: at.ref.id,
      repository: at.ref.repository,
      schema: 1 as const,
    }),
    false,
  );
}

/** A decision record as `graph` and `work check --decisions` read it. */
export interface StoreDecision {
  readonly id: string;
  readonly work: string;
  readonly repository: string | null;
  readonly question: string | null;
  readonly by: string | null;
  readonly at: string | null;
  readonly role: string | null;
  readonly supersedes: string | null;
  readonly text: string | null;
}

/**
 * The store's decision records through `listDecisions`. A decision ID here is `D<n>`; the record's
 * `<work>/D<n>` and `supersedes` keep their full form. Decisions record no repository: work IDs
 * carry their repository's prefix.
 */
export function storeDecisions(store: Pick<Store, "db">): StoreDecision[] {
  return listDecisions(store).map((decision) => ({
    at: decision.at,
    by: decision.by,
    id: decision.id.slice(decision.id.lastIndexOf("/") + 1),
    question: decision.question,
    repository: null,
    role: decision.role,
    supersedes: decision.supersedes,
    text: decision.text,
    work: decision.work,
  }));
}

/**
 * `work check --decisions`: store decisions of this repository's items that the work file in the
 * checked worktree does not record. Each is `{path, decision}`.
 */
export function unrecordedDecisions(
  context: LiveContext,
  worktree: string,
): { readonly path: string; readonly decision: string }[] {
  const coordinator = openCoordinator(context.git, context.coordinatorRoot);
  const repository = repositoryAt(context.git, coordinator, worktree);
  const files = new Map(
    readWorkFiles(worktree).map((file) => [
      file.stem,
      { ids: new Set(parseDecisions(file.text).decisions.map((d) => d.id)), path: file.path },
    ]),
  );
  return withStore(
    context,
    coordinator.layout,
    (store) =>
      storeDecisions(store).flatMap((decision) => {
        if (decision.repository !== null && decision.repository !== repository.name) {
          return [];
        }
        const file = files.get(decision.work);
        if (file === undefined) {
          return decision.repository === repository.name
            ? [
                {
                  decision: `${decision.work}/${decision.id}`,
                  path: `docs/work/${decision.work}.md`,
                },
              ]
            : [];
        }
        return file.ids.has(decision.id)
          ? []
          : [{ decision: `${decision.work}/${decision.id}`, path: file.path }];
      }),
    false,
  );
}
