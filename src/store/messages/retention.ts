/** The persisted boundary text for the first scheduled review after retention. */
export const NEXT_REVIEW_BOUNDARY = "Next scheduled review";

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** A timezone-qualified ISO instant. Reject invalid calendar dates that Date.parse rolls over. */
export function retentionInstant(value: string): number | null {
  if (!INSTANT.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  const date = value.slice(0, 10);
  return Number.isFinite(parsed) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
    ? parsed
    : null;
}
