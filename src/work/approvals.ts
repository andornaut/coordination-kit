// `store import --approval-ledger FILE`: map each approval-ledger entry to a work item in its
// owner's repository and record what the ledger proves as store events. Stage SHAs and proofs
// become `work.evidence`, `unresolved` items become `work.retained`, and `independentHolds` become
// `hold.imported` events owned by their original owner. Import never creates a work file and never
// releases a hold; entries without a work file are listed for their owners to stub.
import { readFileSync } from "node:fs";

import { StateRootError } from "../core/configuration/stateRoot.ts";
import { isRecord } from "../core/encoding/pyjson.ts";
import { type GitRunner, readMainFiles } from "../core/git.ts";
import type { Repository } from "../status/collect.ts";
import { MEMORY, READ_ONLY_CLOCK, Store, type StoreContext } from "../store/db.ts";
import { sha256 } from "../store/eventCodec.ts";
import { holdOpen } from "../store/projections/questions.ts";
import { type CallerOptions, resolveCaller } from "../store/sessions/identity.ts";
import { requirePermission } from "../store/sessions/permissions.ts";
import { type Actor, type Json, StoreError, type WorkRef } from "../store/types.ts";
import {
  type EvidenceInput,
  evidenceKey,
  recordEvidence,
  type RetainedInput,
  retainedKey,
  retainWorkItem,
  SHA,
  type WorkStage,
  workText,
} from "../store/work-records/work.ts";
import { CONVENTION_FILE, parseFrontMatter } from "../workfiles/files.ts";
import { type Coordinator, openCoordinator } from "./live.ts";

const APPROVAL_LEDGER_SOURCE = "approval-ledger";
/** The next boundary of an imported retained item whose ledger entry names none. */
const DEFAULT_NEXT_BOUNDARY = "next scheduled review";

const IMPORT_OUTCOMES = [
  "mapped-id",
  "mapped-title",
  "no-work-file",
  "ambiguous",
  "owner-unregistered",
  "repository-unavailable",
  "invalid",
] as const;
type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];

type Raw = Readonly<Record<string, unknown>>;

interface Counts {
  insert: number;
  unchanged: number;
}

interface ApprovalImportReport {
  readonly schema: 1;
  readonly kind: "approval-ledger-import";
  readonly dryRun: boolean;
  readonly entries: number;
  readonly outcomes: Readonly<Record<ImportOutcome, number>>;
  readonly events: {
    readonly evidence: Counts;
    readonly retained: Counts;
    readonly holds: Counts;
  };
  readonly skipped: {
    /** Stage SHA fields that are present but not a Git object name. */
    readonly invalidSha: number;
    /** Evidence and retained items of entries that map to no work item. */
    readonly unmappedEvidence: number;
    readonly unmappedRetained: number;
  };
  readonly holds: {
    readonly total: number;
    /** Holds whose owner the ledger does not name as a registered role: no one can release them. */
    readonly ownerUnknown: number;
    /** Holds that cover no mapped work item. */
    readonly uncovered: number;
    /** Holds whose ledger state is closed (released, superseded, answered ...): kept as history. */
    readonly closed: number;
  };
  /** Entries with no work file, per owner and repository, for the owner to stub. */
  readonly stubs: readonly {
    readonly owner: string;
    readonly repository: string;
    readonly entries: readonly string[];
  }[];
  /** Every entry that did not map, with its outcome. */
  readonly unmapped: readonly {
    readonly entry: string;
    readonly owner: string | null;
    readonly outcome: ImportOutcome;
  }[];
  readonly mapped: readonly {
    readonly entry: string;
    readonly work: WorkRef;
    readonly outcome: ImportOutcome;
  }[];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A role as the ledger records it: a role name, or an owner object with a `role`. */
function roleOf(raw: Raw, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    const role = str(value) ?? (isRecord(value) ? str(value.role) : null);
    if (role !== null) {
      return role;
    }
  }
  return null;
}

function first(raw: Raw, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = str(raw[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

/** A list field: an array, a keyed object's values, a single item, or nothing. */
function items(value: unknown): { key: string | null; value: unknown }[] {
  if (Array.isArray(value)) {
    return value.map((item) => ({ key: null, value: item as unknown }));
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, item]) => ({ key, value: item }));
  }
  return value === undefined || value === null ? [] : [{ key: null, value }];
}

/** One line of text fit for a store record, or `pointer` when it is long, multi-line or secret-shaped. */
function line(value: string | null, pointer: string): string {
  if (value === null) {
    return pointer;
  }
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length > 512) {
    return pointer;
  }
  try {
    return workText(flat, "invalid");
  } catch {
    return pointer;
  }
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}

interface RepositoryWork {
  readonly ids: ReadonlySet<string>;
  readonly titles: ReadonlyMap<string, string[]>;
}

function repositoryWork(git: GitRunner, repository: Repository): RepositoryWork | null {
  if (repository.reason !== null) {
    return null;
  }
  try {
    const ids = new Set<string>();
    const titles = new Map<string, string[]>();
    for (const file of readMainFiles(git, repository.path, "docs/work").files.values()) {
      const name = file.path.slice("docs/work/".length);
      if (name.includes("/") || !name.endsWith(".md") || name === CONVENTION_FILE) {
        continue;
      }
      const fields = parseFrontMatter(file.text)?.fields ?? {};
      const id = str(fields.id) ?? name.slice(0, -3);
      ids.add(id);
      const title = str(fields.title);
      if (title !== null) {
        const key = normalizeTitle(title);
        titles.set(key, [...(titles.get(key) ?? []), id]);
      }
    }
    return { ids, titles };
  } catch {
    return null;
  }
}

const LEADING_ID = /^([a-z][a-z0-9]*-\d{4,})(?:$|[^0-9])/;

function match(
  entry: string,
  raw: Raw,
  work: RepositoryWork,
): { outcome: ImportOutcome; id: string | null } {
  const byId = [
    first(raw, ["work", "workId", "workItem"]),
    entry,
    LEADING_ID.exec(entry)?.[1] ?? null,
  ];
  for (const candidate of byId) {
    if (candidate !== null && work.ids.has(candidate)) {
      return { id: candidate, outcome: "mapped-id" };
    }
  }
  const title = first(raw, ["title", "behavior"]);
  const found = title === null ? [] : (work.titles.get(normalizeTitle(title)) ?? []);
  if (found.length === 1) {
    return { id: found[0]!, outcome: "mapped-title" };
  }
  return { id: null, outcome: found.length > 1 ? "ambiguous" : "no-work-file" };
}

const SHA_FIELDS: readonly (readonly [string, WorkStage])[] = [
  ["implementationSha", "implemented"],
  ["mainSha", "merged"],
  ["deployedSha", "deployed"],
];

function shaOf(value: unknown): string | null | undefined {
  const text = str(value) ?? (isRecord(value) ? str(value.sha) : null);
  if (text === null) {
    return undefined;
  }
  const lower = text.trim().toLowerCase();
  return SHA.test(lower) ? lower : null;
}

/** The evidence one mapped entry proves, and the count of SHA fields that are not object names. */
function evidenceOf(
  entry: string,
  raw: Raw,
  ref: WorkRef,
): { evidence: EvidenceInput[]; invalidSha: number } {
  const pointer = `${APPROVAL_LEDGER_SOURCE}:${entry}`;
  const evidence: EvidenceInput[] = [];
  let invalidSha = 0;
  const base = { entry, ref, source: APPROVAL_LEDGER_SOURCE };
  for (const [key, stage] of SHA_FIELDS) {
    const sha = shaOf(raw[key]);
    if (sha === null) {
      invalidSha += 1;
    } else if (sha !== undefined) {
      evidence.push({ ...base, evidenceRef: pointer, sha, stage });
    }
  }
  const stage = str(raw.stage);
  const main = shaOf(raw.mainSha);
  const proofStages: WorkStage[] = [];
  if (stage === "verified" || stage === "published" || stage === "deployed") {
    proofStages.push("verified");
  }
  if (stage === "published") {
    proofStages.push("published");
  }
  if (typeof main === "string" && proofStages.length > 0) {
    const proofs = items(raw.interactionProof).map((item, index) =>
      line(
        str(item.value) ?? (isRecord(item.value) ? first(item.value, ["ref", "receipt"]) : null),
        `${pointer}/interactionProof/${item.key ?? index}`,
      ),
    );
    for (const proofStage of proofStages) {
      for (const proof of proofs.length === 0 ? [pointer] : proofs) {
        evidence.push({ ...base, evidenceRef: proof, sha: main, stage: proofStage });
      }
    }
  }
  return { evidence, invalidSha };
}

function retainedOf(
  coordinator: Coordinator,
  entry: string,
  raw: Raw,
  ref: WorkRef,
  owner: string,
): RetainedInput[] {
  const registered = (role: string | null): string | null =>
    role !== null && Object.hasOwn(coordinator.registry.roles, role) ? role : null;
  return items(raw.unresolved).map((item, index) => {
    const pointer = `${APPROVAL_LEDGER_SOURCE}:${entry}/unresolved/${item.key ?? index}`;
    const value = item.value;
    const object = isRecord(value) ? value : null;
    const reason =
      object === null
        ? str(value)
        : first(object, ["gap", "description", "item", "text", "reason", "summary", "missing"]);
    const itemOwner =
      object === null ? null : roleOf(object, ["owner", "requiredOwner", "ownerRole", "role"]);
    const next =
      object === null ? null : first(object, ["nextBoundary", "next", "nextAction", "boundary"]);
    return {
      entry,
      nextBoundary: line(next, DEFAULT_NEXT_BOUNDARY),
      owner: registered(itemOwner) ?? owner,
      reason: line(reason, pointer),
      ref,
      source: APPROVAL_LEDGER_SOURCE,
    };
  });
}

interface HoldPlan {
  readonly id: string;
  readonly owner: string | null;
  /** The ledger's hold state, such as `preserved` or `released`; null when not recorded. */
  readonly state: string | null;
  readonly reason: string;
  readonly work: WorkRef[];
  readonly entries: string[];
}

function holdKey(id: string): string {
  return `hold.imported:${APPROVAL_LEDGER_SOURCE}:${sha256(id).slice(0, 32)}`;
}

/** Read and shape-check the ledger file; refuses `approval-ledger-invalid`. */
function readApprovalLedger(path: string): Raw {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new StoreError("approval-ledger-unreadable");
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !(Array.isArray(value.entries) || isRecord(value.entries))
  ) {
    throw new StoreError("approval-ledger-invalid");
  }
  return value;
}

interface ApprovalImportContext extends StoreContext {
  readonly git: GitRunner;
  readonly coordinatorRoot: string;
}

/** Each ledger entry's work item and outcome, and the events it proves. */
interface ImportPlan {
  readonly entries: number;
  readonly outcomes: Record<ImportOutcome, number>;
  readonly evidence: readonly EvidenceInput[];
  readonly retained: readonly RetainedInput[];
  readonly holds: ReadonlyMap<string, HoldPlan>;
  readonly mapped: ApprovalImportReport["mapped"][number][];
  readonly unmapped: ApprovalImportReport["unmapped"][number][];
  readonly stubs: ApprovalImportReport["stubs"][number][];
  readonly skipped: ApprovalImportReport["skipped"];
}

/**
 * Map every ledger entry to a work item of its owner's repository. Reads nothing itself: `workOf`
 * supplies each repository's work files.
 */
function planImport(
  coordinator: Coordinator,
  workOf: (repository: Repository) => RepositoryWork | null,
  ledger: Raw,
): ImportPlan {
  const outcomes = Object.fromEntries(IMPORT_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    ImportOutcome,
    number
  >;
  const evidence: EvidenceInput[] = [];
  const retained: RetainedInput[] = [];
  const stubs = new Map<string, { owner: string; repository: string; entries: string[] }>();
  const unmapped: ApprovalImportReport["unmapped"][number][] = [];
  const mapped: ApprovalImportReport["mapped"][number][] = [];
  const skipped = { invalidSha: 0, unmappedEvidence: 0, unmappedRetained: 0 };
  const holds = new Map<string, HoldPlan>();
  const topHolds = new Map<string, Raw>();
  items(ledger.independentHolds).forEach((item, index) => {
    if (isRecord(item.value)) {
      topHolds.set(str(item.value.id) ?? item.key ?? `hold-${index}`, item.value);
    } else if (str(item.value) !== null) {
      topHolds.set(str(item.value)!, {});
    }
  });
  const registered = (role: string | null): string | null =>
    role !== null && Object.hasOwn(coordinator.registry.roles, role) ? role : null;
  const holdPlan = (id: string, raw: Raw, fallbackReason: string | null): HoldPlan => {
    let plan = holds.get(id);
    if (plan === undefined) {
      plan = {
        entries: [],
        id: `${APPROVAL_LEDGER_SOURCE}:${id}`,
        owner: registered(roleOf(raw, ["owner", "ownerRole", "role", "requiredOwner"])),
        reason: line(
          first(raw, ["reason", "behavior", "description", "scope", "summary"]) ?? fallbackReason,
          `${APPROVAL_LEDGER_SOURCE}:independentHolds/${id}`,
        ),
        state: str(raw.state),
        work: [],
      };
      holds.set(id, plan);
    }
    return plan;
  };
  for (const id of topHolds.keys()) {
    holdPlan(id, topHolds.get(id)!, topHolds.get(id)!.reason === undefined ? id : null);
  }
  const entries = items(ledger.entries);
  entries.forEach((item, index) => {
    const raw = isRecord(item.value) ? item.value : null;
    const entry = (raw === null ? null : str(raw.id)) ?? item.key ?? `entry-${index}`;
    const outcome = ((): { outcome: ImportOutcome; ref: WorkRef | null; owner: string | null } => {
      if (raw === null) {
        return { outcome: "invalid", owner: null, ref: null };
      }
      const owner = roleOf(raw, ["owner"]);
      if (owner === null || !Object.hasOwn(coordinator.registry.roles, owner)) {
        return { outcome: "owner-unregistered", owner, ref: null };
      }
      const repository = coordinator.repositories.find((repo) => repo.roles.includes(owner));
      if (repository === undefined) {
        return { outcome: "repository-unavailable", owner, ref: null };
      }
      const available = workOf(repository);
      if (available === null) {
        return { outcome: "repository-unavailable", owner, ref: null };
      }
      const found = match(entry, raw, available);
      if (found.outcome === "no-work-file") {
        const key = `${owner}\n${repository.name}`;
        const stub = stubs.get(key) ?? { entries: [], owner, repository: repository.name };
        stub.entries.push(entry);
        stubs.set(key, stub);
      }
      return {
        outcome: found.outcome,
        owner,
        ref: found.id === null ? null : { id: found.id, repository: repository.name },
      };
    })();
    outcomes[outcome.outcome] += 1;
    if (raw !== null) {
      items(raw.independentHolds).forEach((reference, position) => {
        const value = reference.value;
        const id =
          str(value) ?? (isRecord(value) ? str(value.id) : null) ?? `${entry}#hold-${position}`;
        const plan = holdPlan(
          id,
          topHolds.get(id) ?? (isRecord(value) ? value : {}),
          topHolds.has(id) ? null : str(value),
        );
        plan.entries.push(entry);
        if (
          outcome.ref !== null &&
          !plan.work.some(
            (ref) => ref.repository === outcome.ref!.repository && ref.id === outcome.ref!.id,
          )
        ) {
          plan.work.push(outcome.ref);
        }
      });
    }
    if (outcome.ref === null || raw === null) {
      unmapped.push({ entry, outcome: outcome.outcome, owner: outcome.owner });
      if (raw !== null) {
        skipped.unmappedEvidence += SHA_FIELDS.filter(
          ([key]) => shaOf(raw[key]) !== undefined,
        ).length;
        skipped.unmappedRetained += items(raw.unresolved).length;
      }
      return;
    }
    mapped.push({ entry, outcome: outcome.outcome, work: outcome.ref });
    const proven = evidenceOf(entry, raw, outcome.ref);
    skipped.invalidSha += proven.invalidSha;
    evidence.push(...proven.evidence);
    retained.push(...retainedOf(coordinator, entry, raw, outcome.ref, outcome.owner!));
  });
  return {
    entries: entries.length,
    evidence,
    holds,
    mapped,
    outcomes,
    retained,
    skipped,
    stubs: [...stubs.values()].sort((left, right) =>
      `${left.owner}\n${left.repository}`.localeCompare(
        `${right.owner}\n${right.repository}`,
        "en",
      ),
    ),
    unmapped,
  };
}

/** Append the plan's events not yet stored, or only count them in a dry run. */
function applyImport(
  store: Store,
  actor: Actor,
  plan: ImportPlan,
  dryRun: boolean,
): ApprovalImportReport["events"] {
  const counts = {
    evidence: { insert: 0, unchanged: 0 },
    holds: { insert: 0, unchanged: 0 },
    retained: { insert: 0, unchanged: 0 },
  };
  const tally = (bucket: Counts, exists: boolean) => {
    bucket[exists ? "unchanged" : "insert"] += 1;
  };
  const planned = new Set<string>();
  const fresh = (key: string): boolean => {
    const seen = planned.has(key) || store.eventByKey(key) !== undefined;
    planned.add(key);
    return !seen;
  };
  for (const input of plan.evidence) {
    const isNew = fresh(evidenceKey(input));
    tally(counts.evidence, !isNew);
    if (isNew && !dryRun) {
      recordEvidence(store, actor, input);
    }
  }
  for (const input of plan.retained) {
    const isNew = fresh(retainedKey(input));
    tally(counts.retained, !isNew);
    if (isNew && !dryRun) {
      retainWorkItem(store, actor, input);
    }
  }
  for (const hold of plan.holds.values()) {
    const key = holdKey(hold.id);
    const isNew = fresh(key);
    tally(counts.holds, !isNew);
    if (isNew && !dryRun) {
      store.append({
        actor,
        key,
        kind: "hold.imported",
        payload: {
          entries: hold.entries,
          id: hold.id,
          owner: hold.owner,
          reason: hold.reason,
          source: APPROVAL_LEDGER_SOURCE,
          state: hold.state,
          work: hold.work as unknown as Json,
        },
      });
    }
  }
  return counts;
}

/**
 * Map and import the ledger. A dry run takes no caller and writes nothing; it reads the store when
 * one exists (else an in-memory store) to report which events are already recorded. A real import
 * requires a bound caller with store maintenance permission.
 */
export function importApprovalLedger(
  context: ApprovalImportContext,
  options: CallerOptions,
  selection: { readonly file: string; readonly dryRun: boolean },
): ApprovalImportReport {
  const coordinator = openCoordinator(context.git, context.coordinatorRoot);
  let actor: Actor = { nativeId: null, role: null };
  if (!selection.dryRun) {
    actor = resolveCaller(coordinator.registry, context.env, options);
    requirePermission(coordinator.layout, coordinator.registry, actor, "store:maintain");
  }
  const ledger = readApprovalLedger(selection.file);
  const work = new Map<string, RepositoryWork | null>();
  const plan = planImport(
    coordinator,
    (repository) => {
      if (!work.has(repository.name)) {
        work.set(repository.name, repositoryWork(context.git, repository));
      }
      return work.get(repository.name)!;
    },
    ledger,
  );
  let events: ApprovalImportReport["events"];
  let store: Store;
  try {
    store = selection.dryRun
      ? (Store.readLayout(context, coordinator.layout) ?? Store.open(READ_ONLY_CLOCK, MEMORY))
      : Store.forLayout(context, coordinator.layout);
  } catch (error) {
    if (error instanceof StateRootError) {
      throw new StoreError("store-unavailable");
    }
    throw error;
  }
  try {
    const apply = () => applyImport(store, actor, plan, selection.dryRun);
    events = selection.dryRun ? apply() : store.transaction(apply);
  } finally {
    store.close();
  }
  const holdList = [...plan.holds.values()];
  return {
    dryRun: selection.dryRun,
    entries: plan.entries,
    events,
    holds: {
      closed: holdList.filter((hold) => !holdOpen(hold.state)).length,
      ownerUnknown: holdList.filter((hold) => hold.owner === null).length,
      total: holdList.length,
      uncovered: holdList.filter((hold) => hold.work.length === 0).length,
    },
    kind: "approval-ledger-import",
    mapped: plan.mapped,
    outcomes: plan.outcomes,
    schema: 1,
    skipped: plan.skipped,
    stubs: plan.stubs,
    unmapped: plan.unmapped,
  };
}
