// `work report`: each work item's front-matter state. Live progress is in the store (`work show`)
// and the cross-repository view is `status`; reading changes nothing.
import { loadLayout } from "../layout.ts";
import { field, readWorkFiles, type WorkFile } from "./files.ts";

export interface WorkReportItem {
  readonly id: string | null;
  readonly path: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly design: string | null;
}

export type CoordinatorState =
  | { readonly status: "absent" }
  | { readonly status: "available"; readonly root: string }
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

/** Report `repository`'s work items; `coordinator` says whether the coordinator root loads. */
export function reportWork(coordinatorRoot: string | undefined, repository: string): WorkReport {
  const items = readWorkFiles(repository).map(frontMatterItem);
  if (coordinatorRoot === undefined) {
    return { coordinator: { status: "absent" }, items };
  }
  try {
    return { coordinator: { root: loadLayout(coordinatorRoot).root, status: "available" }, items };
  } catch (error) {
    return {
      coordinator: {
        reason: error instanceof Error ? error.message : String(error),
        root: coordinatorRoot,
        status: "unavailable",
      },
      items,
    };
  }
}
