import { describe, expect, it } from "vitest";

import { findNamedWork } from "./discovery.ts";

const records = [
  { id: "ck-001", repository: "z", title: "Build Mode" },
  { id: "ck-004", repository: "a", title: "Build mode on Linux" },
  { id: "ck-002", repository: "a", title: "ck-001" },
];

describe("named work lookup", () => {
  it("prefers a canonical ID over a matching title", () => {
    expect(findNamedWork("ck-001", records, true)).toEqual({
      match: "id",
      matches: [records[0]],
      status: "match",
    });
  });

  it("normalizes the title before considering token matches", () => {
    expect(findNamedWork("  BUILD  MODE  ", records, true)).toEqual({
      match: "title",
      matches: [records[0]],
      status: "match",
    });
  });

  it("reports competing token matches in a stable, canonical order", () => {
    expect(findNamedWork("mode build", records, true)).toEqual({
      match: "tokens",
      matches: [records[1], records[0]],
      status: "ambiguous",
    });
  });

  it("keeps even a possible exact ID uncertain when a scoped source is unreadable", () => {
    expect(findNamedWork("ck-001", records, false)).toEqual({
      match: "id",
      matches: [records[0]],
      status: "unavailable",
    });
    expect(findNamedWork("deployment", records, false)).toMatchObject({ status: "unavailable" });
    expect(findNamedWork("deployment", records, true)).toMatchObject({ status: "no-match" });
  });
});
