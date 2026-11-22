// The `status --format markdown` digest: per repository, items under Done, In progress, New,
// Outstanding and Waiting on the user. Each item appears under exactly one heading.
import type { StatusItem, StatusReport } from "./collect.ts";
import type { DerivedStatus } from "./derive.ts";

export const DIGEST_HEADINGS = [
  "Done",
  "In progress",
  "New",
  "Outstanding",
  "Waiting on the user",
] as const;
export type DigestHeading = (typeof DIGEST_HEADINGS)[number];

const BY_STATUS: Readonly<Record<DerivedStatus, DigestHeading>> = {
  approved: "Outstanding",
  cancelled: "Done",
  declined: "Done",
  deployed: "Done",
  done: "Done",
  "in-progress": "In progress",
  landed: "In progress",
  proposed: "Waiting on the user",
  requested: "New",
  superseded: "Done",
};

/** Waiting on the user first (proposed, or a pending question), then by derived status. */
export function digestHeading(item: StatusItem): DigestHeading {
  return item.waitingOnUser ? "Waiting on the user" : BY_STATUS[item.status];
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function line(item: StatusItem): string {
  const details: string[] = [item.status];
  if (item.replacement !== null) {
    details.push(`replaced by ${item.replacement}`);
  }
  if (item.delivery.landing !== null) {
    const { rule, sha } = item.delivery.landing;
    details.push(rule === "done-flip" ? `landed ${short(sha)}` : `${rule} citation ${short(sha)}`);
  }
  if (item.delivery.deployed !== null) {
    const { deployed } = item.delivery;
    const how = deployed.via === "release" ? `released ${deployed.tag ?? ""}` : "deployed";
    details.push(deployed.at === null ? how : `${how} ${deployed.at}`);
  } else if (item.deliveryEvidence === "assumed") {
    details.push("delivery assumed");
  }
  if (item.delivery.heuristicDeployment !== null) {
    details.push(`deployment includes citation ${short(item.delivery.heuristicDeployment.sha)}`);
  }
  if (item.blocked) {
    details.push(`blocked${item.owner === null ? "" : ` on ${item.owner}`}`);
  }
  if (item.workFile === null && item.store !== null) {
    details.push("work file unavailable");
  }
  const title = inline(item.title ?? "");
  const marker = item.deliveryVerified === false ? " (unverified)" : "";
  return `- ${item.id}${title === "" ? "" : `: ${title}`}${marker} (${details.join("; ")})`;
}

function sourceLine(name: string, state: { status: string; reason?: string }): string | null {
  if (state.status === "available") {
    return null;
  }
  return `- ${name}: ${state.status}${state.reason === undefined ? "" : ` (${state.reason})`}`;
}

function section(out: string[], heading: string, lines: readonly string[]): void {
  out.push(`## ${heading}`, "", ...(lines.length === 0 ? ["None."] : lines), "");
}

/** The digest of `report`, grouped per repository under the five headings. */
export function renderMarkdown(report: StatusReport): string {
  const out: string[] = ["# Status", ""];
  const { filters } = report;
  const applied = [
    `scope ${filters.scope}`,
    ...(filters.since === null ? [] : [`since ${filters.since}`]),
    ...(filters.states.length === 0 ? [] : [`state ${filters.states.join(", ")}`]),
    ...(filters.audit ? ["audit"] : []),
  ];
  out.push(`Filters: ${applied.join("; ")}.`, "");
  const store =
    report.coordinator.store.status === "absent"
      ? null
      : sourceLine("Store", report.coordinator.store);
  const sources = store === null ? [] : [store];
  if (sources.length > 0) {
    out.push("Sources not fully read:", "", ...sources, "");
  }
  const fromStore = (lines: readonly string[]) =>
    report.coordinator.store.status === "unavailable" ? ["Unavailable."] : lines;
  section(
    out,
    "Recorded pending questions",
    fromStore(
      report.pendingQuestions.map(
        ({ id, role, title, work }) =>
          `- ${id} (${role}${work === null ? "" : `, ${work}`}) ${inline(title)}`,
      ),
    ),
  );
  section(
    out,
    "Active holds",
    fromStore(
      report.activeHolds.map(
        ({ id, policy, reason, role, scope }) =>
          `- ${id} (${policy?.issuer ?? role ?? "owner unknown"}, ${scope}) ${inline(reason)}`,
      ),
    ),
  );
  section(
    out,
    "Unmatched legacy requests",
    fromStore(
      report.unmatchedRequests.map(
        ({ id, owner, state, summary, work }) =>
          `- ${id} (${owner}, ${state}) ${inline(summary)}${work.length === 0 ? "" : ` [${work.join(", ")}]`}`,
      ),
    ),
  );
  if (filters.since !== null) {
    const timed = ({ at, id, repository }: StatusReport["recentActivity"][number]) =>
      `- ${repository}/${id} ${at}`;
    section(out, "Recent activity", report.recentActivity.map(timed));
    section(out, "Recent completions", report.recentCompletions.map(timed));
  }
  for (const repo of report.repositories) {
    out.push(`## ${repo.name}`, "");
    if (repo.status === "unavailable") {
      out.push(`Unavailable: ${repo.reason ?? "unknown"}.`, "");
    }
    if (repo.deployment.status === "unavailable" || repo.deployment.unreadable > 0) {
      out.push(
        `Deployment evidence incomplete: ${repo.deployment.status}, ${repo.deployment.unreadable} unreadable.`,
        "",
      );
    }
    const items = report.items.filter((item) => item.repository === repo.name);
    for (const heading of DIGEST_HEADINGS) {
      const under = items.filter((item) => digestHeading(item) === heading);
      out.push(`### ${heading}`, "", ...(under.length === 0 ? ["None."] : under.map(line)), "");
    }
  }
  const reported = new Set(report.repositories.map(({ name }) => name));
  const unregistered = report.items.filter(({ repository }) => !reported.has(repository));
  if (unregistered.length > 0) {
    section(
      out,
      "Work in unregistered repositories",
      unregistered.map((item) => line({ ...item, id: `${item.repository}/${item.id}` })),
    );
  }
  return `${out.join("\n").trimEnd()}\n`;
}
