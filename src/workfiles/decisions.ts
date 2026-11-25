// Decision lines in a work file's Decisions section:
//   - D2 (user, 2026-11-18; answers q-coordination-kit-14; supersedes D1): text
// `answers` and `supersedes` are optional and in that order. A supersedes target is a decision of
// the same item (`D1`) or of another item (`ck-0006/D1`). Other bullets in the section are prose.

export interface DecisionLine {
  /** `D<n>`. */
  readonly id: string;
  /** 1-based line number in the file. */
  readonly line: number;
  /** Who decided: `user` or a registry role name. */
  readonly by: string;
  /** YYYY-MM-DD. */
  readonly at: string;
  readonly answers: string | null;
  /** `D<n>` within the item or `<work-id>/D<n>`. */
  readonly supersedes: string | null;
  readonly text: string;
}

export interface DecisionProblem {
  readonly line: number;
  readonly reason: string;
}

export interface Decisions {
  readonly decisions: readonly DecisionLine[];
  readonly problems: readonly DecisionProblem[];
}

const DECISION = new RegExp(
  "^- (D[1-9][0-9]*) \\(" +
    "(user|[a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)?), " +
    "(\\d{4}-\\d{2}-\\d{2})" +
    "(?:; answers ([a-z0-9][a-z0-9/-]*))?" +
    "(?:; supersedes ((?:[a-z][a-z0-9]*-\\d{4,}/)?D[1-9][0-9]*))?" +
    "\\): (\\S.*)$",
);
/** A bullet that starts like a decision: `- D` and a digit. */
const DECISION_SHAPED = /^- D\d/;

function validDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value);
}

/** The decision lines of `text` and every malformed decision-shaped line. */
export function parseDecisions(text: string): Decisions {
  const lines = text.split("\n");
  const decisions: DecisionLine[] = [];
  const problems: DecisionProblem[] = [];
  let inSection = false;
  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    if (/^## /.test(line)) {
      inSection = line === "## Decisions";
      return;
    }
    if (!inSection || !DECISION_SHAPED.test(line)) {
      return;
    }
    const match = DECISION.exec(line);
    if (match === null) {
      problems.push({
        line: index + 1,
        reason: "expected - Dn (BY, YYYY-MM-DD[; answers Q][; supersedes Dk]): text",
      });
      return;
    }
    const [, id = "", by = "", at = "", answers, supersedes, body = ""] = match;
    if (!validDate(at)) {
      problems.push({ line: index + 1, reason: `${at} is not a calendar date` });
      return;
    }
    decisions.push({
      answers: answers ?? null,
      at,
      by,
      id,
      line: index + 1,
      supersedes: supersedes ?? null,
      text: body.trim(),
    });
  });
  const seen = new Set<string>();
  for (const decision of decisions) {
    if (seen.has(decision.id)) {
      problems.push({ line: decision.line, reason: `${decision.id} is repeated` });
    }
    seen.add(decision.id);
  }
  for (const decision of decisions) {
    const target = decision.supersedes;
    if (target !== null && !target.includes("/") && !seen.has(target)) {
      problems.push({
        line: decision.line,
        reason: `supersedes ${target}, which is not a decision of this item`,
      });
    }
    if (target === decision.id) {
      problems.push({ line: decision.line, reason: `${decision.id} supersedes itself` });
    }
  }
  problems.sort((left, right) => left.line - right.line);
  return { decisions, problems };
}
