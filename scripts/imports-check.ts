// The src/ import graph has no cycles, type-only imports included. Reads the sources with the
// TypeScript parser and follows relative specifiers only. Runs in lint.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { isMain } from "./check.ts";

/** Each module's relative imports, keyed and valued by path relative to the root. */
export type Graph = ReadonlyMap<string, readonly string[]>;

/** Every relative specifier a module imports or re-exports, type-only ones included. */
export function specifiers(source: string): string[] {
  const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest);
  return file.statements.flatMap((statement) =>
    (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteral(statement.moduleSpecifier) &&
    statement.moduleSpecifier.text.startsWith(".")
      ? [statement.moduleSpecifier.text]
      : [],
  );
}

/** The graph of every .ts file under `dir`. */
export function readGraph(root: string, dir: string): Graph {
  const graph = new Map<string, string[]>();
  for (const name of readdirSync(join(root, dir), { recursive: true }) as string[]) {
    if (!name.endsWith(".ts")) continue;
    const path = join(dir, name);
    graph.set(
      path,
      specifiers(readFileSync(join(root, path), "utf8")).map((specifier) =>
        relative(root, resolve(root, dirname(path), specifier)),
      ),
    );
  }
  return graph;
}

/** Each strongly connected component of more than one module, or a module importing itself. */
export function cycles(graph: Graph): string[][] {
  let next = 0;
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: string[] = [],
    found: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    for (const target of graph.get(node) ?? []) {
      if (!graph.has(target)) continue;
      if (!index.has(target)) visit(target);
      if (stack.includes(target)) low.set(node, Math.min(low.get(node)!, low.get(target)!));
    }
    if (low.get(node) !== index.get(node)) return;
    const component = stack.splice(stack.indexOf(node));
    if (component.length > 1 || graph.get(node)!.includes(node)) found.push(component.sort());
  };
  for (const node of [...graph.keys()].sort()) if (!index.has(node)) visit(node);
  return found;
}

/** One message per finding. */
export function importFindings(graph: Graph): string[] {
  return cycles(graph).map((component) => `import cycle: ${component.join(" -> ")}`);
}

if (isMain(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const findings = importFindings(readGraph(root, "src"));
  for (const finding of findings) console.error(`imports-check: ${finding}`);
  if (findings.length > 0) process.exitCode = 1;
}
