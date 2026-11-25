// `store retire`: the one-time 3.0 migration. It imports every open request of the frozen request
// ledger as a `request.imported` record, drops the pending intake offers, archives the retired
// protocol state as one tar.gz with a manifest under `<stateRoot>/archive/`, and records
// `store.retired`. It never deletes or changes an original; a repeated apply is a no-op.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { writeJsonDurable } from "../core/durable.ts";
import type { Layout } from "../core/layout.ts";
import { isRecord } from "../core/pyjson.ts";
import { stateRoot } from "../core/stateRoot.ts";
import { Store } from "./db.ts";
import { sha256 } from "./eventCodec.ts";
import { type CallerOptions, resolveCaller } from "./identity.ts";
import { importRequest, type RequestImport } from "./requests.ts";
import { registry, type StoreServiceContext } from "./service.ts";
import { type Actor, type JsonObject, StoreError } from "./types.ts";

export const COORDINATOR_ROLE = "game-coordinator";
/** The state-root directories and file the archive holds, beside the coordinator's fence. */
export const RETIRED_PATHS = ["roles", "accounting", "transport", "locks", "migration"] as const;
const RETIRED_FILES = ["migration-plan.json"] as const;
const FENCE = "var/work-protocol-fence.json";
export const READ_WITH = {
  package: "@andornaut/coordination-kit",
  url: "https://github.com/andornaut/coordination-kit/releases/download/v2.1.2/coordination-kit-2.1.2.tgz",
  version: "2.1.2",
} as const;
const RETIRED_KEY = "store.retired:phase4";
/** Ledger states that close a request; every other request is imported. */
const CLOSED_STATES: ReadonlySet<string> = new Set(["completed", "cancelled", "superseded"]);
const WORK_ID = /^[a-z][a-z0-9]{0,15}-\d{4}$/;

interface RetiredPath {
  /** Relative to the state root, or `var/...` for the coordinator's fence file. */
  readonly path: string;
  readonly present: boolean;
  readonly files: number;
  readonly bytes: number;
}

export interface RetireOutput {
  readonly schema: 1;
  readonly kind: "store-retire";
  readonly dryRun: boolean;
  /** True once `store.retired` is recorded, by this call or an earlier one. */
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly stateRoot: string;
  readonly paths: readonly RetiredPath[];
  readonly requests: {
    readonly ledger: number;
    readonly closed: number;
    readonly imported: number;
    readonly alreadyImported: number;
    /** Imported requests whose owner is not a registered role: no binding can close them. */
    readonly unowned: readonly string[];
    readonly byState: Readonly<Record<string, number>>;
  };
  readonly intakeOffers: { readonly dropped: number };
  readonly archive: {
    readonly path: string;
    readonly manifest: string;
    readonly sha256: string | null;
    readonly bytes: number | null;
  };
}

interface LedgerRequest {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly state: string;
  readonly createdBy: string;
  readonly assignment: { readonly ownerRole?: unknown } | null;
  readonly source: { readonly origin?: unknown; readonly reference?: unknown } | null;
  readonly question: { readonly status?: unknown } | null;
  readonly targets?: readonly { readonly id?: unknown }[];
  readonly reason: string | null;
  readonly requiredOwner: string | null;
  readonly updatedAt: string;
}

/**
 * The frozen ledger's current requests from `accounting/checkpoint.json`, read-only. The checkpoint
 * must be intact and cover every journal event (`ledger-checkpoint-stale` otherwise); its revision
 * and hash are checked against the last event file, so no replay is needed.
 */
export function readLedgerRequests(root: string): LedgerRequest[] {
  const directory = join(root, "accounting");
  let events: string[];
  try {
    events = readdirSync(join(directory, "events"))
      .filter((name) => /^\d{12}\.json$/.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw new StoreError("ledger-unreadable");
  }
  if (events.length === 0) {
    return [];
  }
  let checkpoint: unknown;
  let last: unknown;
  try {
    checkpoint = JSON.parse(readFileSync(join(directory, "checkpoint.json"), "utf8"));
    last = JSON.parse(readFileSync(join(directory, "events", events.at(-1)!), "utf8"));
  } catch {
    throw new StoreError("ledger-checkpoint-stale");
  }
  if (!isRecord(checkpoint) || checkpoint.schema !== 1 || !isRecord(checkpoint.state)) {
    throw new StoreError("ledger-checkpoint-stale");
  }
  const state = checkpoint.state;
  const digest = sha256(JSON.stringify(state));
  if (
    checkpoint.digest !== digest ||
    state.revision !== events.length ||
    !isRecord(last) ||
    last.revision !== events.length ||
    last.hash !== state.hash ||
    !Array.isArray(state.requests)
  ) {
    throw new StoreError("ledger-checkpoint-stale");
  }
  return state.requests as LedgerRequest[];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The store record of one open ledger request. */
function requestImport(request: LedgerRequest): RequestImport {
  const owner = stringOrNull(request.assignment?.ownerRole) ?? request.createdBy;
  const work = new Set<string>();
  for (const id of [request.id, ...(request.targets ?? []).map((target) => target.id)]) {
    if (typeof id === "string" && WORK_ID.test(id)) {
      work.add(id);
    }
  }
  return {
    id: request.id,
    kind: request.kind,
    owner,
    question: stringOrNull(request.question?.status),
    reason: request.reason ?? null,
    requiredOwner: request.requiredOwner ?? null,
    source: {
      origin: stringOrNull(request.source?.origin),
      reference: stringOrNull(request.source?.reference),
    },
    state: request.state,
    summary: request.summary,
    updatedAt: request.updatedAt,
    work: [...work].sort(),
  };
}

function measure(path: string): { present: boolean; files: number; bytes: number } {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { bytes: 0, files: 0, present: false };
  }
  if (!stat.isDirectory()) {
    return { bytes: stat.size, files: 1, present: true };
  }
  let files = 0;
  let bytes = 0;
  const stack = [path];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
      } else {
        files += 1;
        bytes += lstatSync(child).size;
      }
    }
  }
  return { bytes, files, present: true };
}

function retiredPaths(layout: Layout, root: string): RetiredPath[] {
  return [
    ...[...RETIRED_PATHS, ...RETIRED_FILES].map((path) => ({ path, ...measure(join(root, path)) })),
    { path: FENCE, ...measure(join(layout.root, FENCE)) },
  ];
}

function intakeOffers(root: string): number {
  try {
    return readdirSync(join(root, "accounting", "intake")).filter((name) => name.endsWith(".json"))
      .length;
  } catch {
    return 0;
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** The system `tar` with fixed arguments: state-root members, then the coordinator's fence. */
async function writeArchive(
  layout: Layout,
  root: string,
  paths: readonly RetiredPath[],
  target: string,
): Promise<void> {
  const present = (path: string): boolean =>
    paths.some((item) => item.path === path && item.present);
  const members = [...RETIRED_PATHS, ...RETIRED_FILES].filter(present);
  const args = ["-czf", target, "-C", root, ...members];
  if (present(FENCE)) {
    args.push("-C", layout.root, FENCE);
  }
  await promisify(execFile)("tar", args, { maxBuffer: 1024 * 1024 });
}

interface RetireOptions {
  readonly apply: boolean;
  /** The UTC date of the archive name; defaults to today. */
  readonly date?: string;
}

/**
 * The retirement. A dry run takes no caller and writes nothing. An apply requires the caller to be
 * game-coordinator through the registry fence, then archives, writes the manifest and records the
 * imports and `store.retired` in one transaction.
 */
export async function storeRetire(
  context: StoreServiceContext,
  callerOptions: CallerOptions,
  options: RetireOptions,
): Promise<RetireOutput> {
  let actor: Actor = { nativeId: null, role: null };
  if (options.apply) {
    actor = resolveCaller(registry(context), context.env, callerOptions);
    if (actor.role !== COORDINATOR_ROLE) {
      throw new StoreError("not-coordinator");
    }
  }
  const root = stateRoot(context.layout);
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const archiveDir = join(root, "archive");
  const archivePath = join(archiveDir, `phase4-${date}.tar.gz`);
  const manifestPath = join(archiveDir, `phase4-${date}.json`);
  const store = options.apply
    ? Store.forLayout(context.layout, context.now === undefined ? {} : { now: context.now })
    : Store.readLayout(context.layout);
  const payloadOf = (key: string): JsonObject | undefined => store?.eventByKey(key)?.payload;
  try {
    const recorded = payloadOf(RETIRED_KEY);
    if (recorded !== undefined) {
      return {
        ...(recorded as unknown as RetireOutput),
        applied: true,
        dryRun: !options.apply,
        duplicate: true,
      };
    }
    const ledger = readLedgerRequests(root);
    const open = ledger.filter((request) => !CLOSED_STATES.has(request.state));
    const already = open.filter(
      (request) => payloadOf(`request.imported:${request.id}`) !== undefined,
    ).length;
    let roles: ReadonlySet<string>;
    try {
      roles = new Set(Object.keys(registry(context).roles));
    } catch {
      roles = new Set();
    }
    const byState: Record<string, number> = {};
    for (const request of open) {
      byState[request.state] = (byState[request.state] ?? 0) + 1;
    }
    const imports = open.map(requestImport);
    const paths = retiredPaths(context.layout, root);
    const output: RetireOutput = {
      applied: false,
      archive: { bytes: null, manifest: manifestPath, path: archivePath, sha256: null },
      dryRun: !options.apply,
      duplicate: false,
      intakeOffers: { dropped: intakeOffers(root) },
      kind: "store-retire",
      paths,
      requests: {
        alreadyImported: already,
        byState,
        closed: ledger.length - open.length,
        imported: open.length - already,
        ledger: ledger.length,
        unowned: imports.filter((item) => !roles.has(item.owner)).map((item) => item.id),
      },
      schema: 1,
      stateRoot: root,
    };
    if (!options.apply || store === null) {
      return output;
    }
    mkdirSync(archiveDir, { mode: 0o700, recursive: true });
    const temporary = join(archiveDir, `.phase4-${date}.tar.gz.${process.pid}.tmp`);
    await writeArchive(context.layout, root, paths, temporary);
    renameSync(temporary, archivePath);
    const sha256 = await sha256File(archivePath);
    const bytes = lstatSync(archivePath).size;
    const applied: RetireOutput = {
      ...output,
      applied: true,
      archive: { bytes, manifest: manifestPath, path: archivePath, sha256 },
    };
    writeJsonDurable(manifestPath, {
      archive: { bytes, name: `phase4-${date}.tar.gz`, sha256 },
      createdAt: new Date().toISOString(),
      kind: "phase4-archive",
      paths: paths
        .filter((item) => item.present)
        .map(({ bytes: size, files, path: member }) => ({
          bytes: size,
          files,
          path: member,
        })),
      readWith: READ_WITH,
      schema: 1,
      stateRoot: root,
    });
    store.transaction(() => {
      for (const item of imports) {
        importRequest(store, actor, item);
      }
      store.append({
        actor,
        key: RETIRED_KEY,
        kind: "store.retired",
        payload: JSON.parse(JSON.stringify(applied)) as JsonObject,
      });
    });
    return applied;
  } finally {
    store?.close();
  }
}
