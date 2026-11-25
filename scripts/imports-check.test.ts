// The import graph check against small graphs and this repository's src/.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { cycles, importFindings, readGraph, specifiers } from "./imports-check.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("specifiers", () => {
  it("lists relative imports and re-exports, type-only ones included", () => {
    expect(
      specifiers(
        [
          'import { a } from "./a.ts";',
          'import type { B } from "../b.ts";',
          'import { type C } from "./c.ts";',
          'export { d } from "./d.ts";',
          'export type * from "./e.ts";',
          'import { join } from "node:path";',
          "export const f = 1;",
        ].join("\n"),
      ),
    ).toEqual(["./a.ts", "../b.ts", "./c.ts", "./d.ts", "./e.ts"]);
  });
});

describe("cycles", () => {
  it("reports each strongly connected component once and ignores unknown targets", () => {
    const graph = new Map([
      ["a", ["b", "outside"]],
      ["b", ["c"]],
      ["c", ["a", "d"]],
      ["d", ["e"]],
      ["e", ["d"]],
      ["f", ["f"]],
      ["g", ["a"]],
    ]);
    expect(cycles(graph)).toEqual([["d", "e"], ["a", "b", "c"], ["f"]]);
  });

  it("accepts an acyclic graph", () => {
    expect(
      cycles(
        new Map([
          ["a", ["b", "c"]],
          ["b", ["c"]],
          ["c", []],
        ]),
      ),
    ).toEqual([]);
  });
});

describe("this repository", () => {
  it("has no import cycles in src/", () => {
    expect(importFindings(readGraph(root, "src"))).toEqual([]);
  });
});
