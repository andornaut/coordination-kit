// `work report`: each work item's front-matter status, joined with live protocol state when a
// coordinator root is available. Reading changes no protocol, ledger or registry state, and an
// unavailable source is reported as unavailable, never as absent work.
import type { LedgerRequest } from "../accounting/types.ts";
import type { Io } from "../io.ts";
import { loadLayout } from "../layout.ts";
import type { ProtocolStore } from "../protocol/core.ts";
import { enrollmentRequests } from "../protocol/enrollment-runtime.ts";
import {
  ledgerStorageOptions,
  protocolFailure,
  runtimeProtocolStore,
} from "../protocol/runtime.ts";
import { WorkStore } from "../protocol/work.ts";
import { field, readWorkFiles, type WorkFile } from "./files.ts";

export interface WorkPublicationState {
  /** How the publication names this work file: its definition ID, its plan path or both. */
  readonly joinedBy: readonly ("id" | "path")[];
  /** The plan's work-file reference; references only, never approval. */
  readonly plan: { readonly path: string | null; readonly commit: string | null };
  readonly role: string;
  readonly revision: number;
  readonly ready: boolean;
  /** Every criterion phase and consumer has a passed receipt; null when unevaluable. */
  readonly receiptsSatisfied: boolean | null;
  /** Each linked request's ledger state, or "unknown" when the ledger has no readable record. */
  readonly requests: readonly { readonly id: string; readonly state: string }[];
}

export interface WorkReportItem {
  readonly id: string | null;
  readonly path: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly design: string | null;
  /** Present only with a coordinator root whose protocol state was read. */
  readonly publications?: readonly WorkPublicationState[];
}

export type CoordinatorState =
  | { readonly status: "absent" }
  | { readonly status: "available"; readonly root: string }
  | { readonly status: "unconfigured"; readonly root: string }
  | { readonly status: "unavailable"; readonly root: string; readonly reason: string };

export interface WorkReport {
  readonly coordinator: CoordinatorState;
  readonly items: readonly WorkReportItem[];
}

function frontMatterItem(file: WorkFile): WorkReportItem {
  return {
    design: field(file, "design") ?? null,
    id: field(file, "id") ?? null,
    path: file.path,
    status: field(file, "status") ?? null,
    title: field(file, "title") ?? null,
  };
}

function requestStates(
  requests: ReadonlyMap<string, LedgerRequest> | null,
  ids: readonly string[],
): { id: string; state: string }[] {
  return ids.map((id) => ({ id, state: requests?.get(id)?.state ?? "unknown" }));
}

/** Publications keyed by the work file path they join, by definition ID or by plan path. */
function publications(
  protocol: ProtocolStore,
  requests: ReadonlyMap<string, LedgerRequest> | null,
  items: readonly WorkReportItem[],
): Map<string, WorkPublicationState[]> {
  const work = new WorkStore({ protocol, readRequest: (id) => requests?.get(id) });
  const byId = new Map<string, string[]>();
  for (const item of items) {
    if (item.id !== null) {
      byId.set(item.id, [...(byId.get(item.id) ?? []), item.path]);
    }
  }
  const paths = new Set(items.map((item) => item.path));
  const found = new Map<string, WorkPublicationState[]>();
  for (const role of protocol.listRoles()) {
    for (const entry of work.index(role).items) {
      const publication = work.read(role, entry.id);
      const plan = publication?.definition.plan;
      const joined = new Map<string, ("id" | "path")[]>();
      for (const path of byId.get(entry.id) ?? []) {
        joined.set(path, ["id"]);
      }
      if (plan?.path !== undefined && paths.has(plan.path)) {
        joined.set(plan.path, [...(joined.get(plan.path) ?? []), "path"]);
      }
      if (joined.size === 0) {
        continue;
      }
      let receiptsSatisfied: boolean | null;
      try {
        receiptsSatisfied = work.evaluate(role, entry.id).criteriaSatisfied;
      } catch {
        receiptsSatisfied = null;
      }
      for (const [path, joinedBy] of joined) {
        found.set(path, [
          ...(found.get(path) ?? []),
          {
            joinedBy,
            plan: { commit: plan?.commit ?? null, path: plan?.path ?? null },
            ready: entry.ready,
            receiptsSatisfied,
            requests: requestStates(requests, publication?.definition.requestIds ?? []),
            revision: entry.revision,
            role,
          },
        ]);
      }
    }
  }
  return found;
}

function failure(error: unknown): string {
  return protocolFailure(error) ?? "protocol-read-failed";
}

/**
 * Report `repository`'s work items. With `coordinatorRoot`, each item also lists the work
 * publications, in every published role, whose definition ID equals its front-matter `id` or whose
 * plan path names its file.
 */
export function reportWork(
  io: Pick<Io, "env">,
  coordinatorRoot: string | undefined,
  repository: string,
): WorkReport {
  const items = readWorkFiles(repository).map(frontMatterItem);
  if (coordinatorRoot === undefined) {
    return { coordinator: { status: "absent" }, items };
  }
  let protocol: ProtocolStore | null;
  let layout;
  try {
    layout = loadLayout(coordinatorRoot);
    protocol = runtimeProtocolStore(layout, io);
  } catch (error) {
    return {
      coordinator: { reason: failure(error), root: coordinatorRoot, status: "unavailable" },
      items,
    };
  }
  if (protocol === null) {
    return { coordinator: { root: layout.root, status: "unconfigured" }, items };
  }
  let requests: ReadonlyMap<string, LedgerRequest> | null;
  try {
    requests = enrollmentRequests(ledgerStorageOptions(layout, io).directory);
  } catch {
    requests = null;
  }
  let found: Map<string, WorkPublicationState[]>;
  try {
    found = publications(protocol, requests, items);
  } catch (error) {
    return {
      coordinator: { reason: failure(error), root: layout.root, status: "unavailable" },
      items,
    };
  }
  return {
    coordinator: { root: layout.root, status: "available" },
    items: items.map((item) => ({
      ...item,
      publications: found.get(item.path) ?? [],
    })),
  };
}
