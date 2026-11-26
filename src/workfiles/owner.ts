import type { FrontMatterValue } from "./files.ts";

export type RepositoryKind = "game" | "kit" | "coordinator" | "other";

/** Resolve the work-file owner to a role registered for its repository. */
export function workOwner(
  repository: {
    readonly name: string;
    readonly kind: RepositoryKind;
    readonly roles: readonly string[];
  },
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
