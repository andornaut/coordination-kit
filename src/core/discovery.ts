interface NamedWork {
  readonly id: string;
  readonly repository?: string;
  readonly title: string | null;
}

type Match = "id" | "title" | "tokens";
type Status = "match" | "ambiguous" | "no-match" | "unavailable";

function normalize(text: string): string {
  return text.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
}

function words(text: string): readonly string[] {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function tier(
  query: string,
  title: string,
  tokens: readonly string[],
  record: NamedWork,
): Match | null {
  if (record.id === query) {
    return "id";
  }
  if (title !== "" && record.title !== null && normalize(record.title) === title) {
    return "title";
  }
  const indexed = new Set(words(`${record.id} ${record.title ?? ""}`));
  return tokens.length > 0 && tokens.every((token) => indexed.has(token)) ? "tokens" : null;
}

function order(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Search the supplied read model only. Partial sources never establish a unique match. */
export function findNamedWork<T extends NamedWork>(
  description: string,
  records: readonly T[],
  complete: boolean,
): { readonly match: Match | null; readonly matches: readonly T[]; readonly status: Status } {
  const query = description.trim();
  const title = normalize(query);
  const tokens = words(query);
  const tiers: Record<Match, T[]> = { id: [], title: [], tokens: [] };
  for (const record of records) {
    const match = tier(query, title, tokens, record);
    if (match !== null) {
      tiers[match].push(record);
    }
  }
  const match = (["id", "title", "tokens"] as const).find((name) => tiers[name].length > 0) ?? null;
  const matches =
    match === null
      ? []
      : tiers[match].sort(
          (left, right) =>
            order(left.repository ?? "", right.repository ?? "") || order(left.id, right.id),
        );
  const status = !complete
    ? "unavailable"
    : matches.length === 0
      ? "no-match"
      : matches.length === 1
        ? "match"
        : "ambiguous";
  return { match, matches, status };
}
