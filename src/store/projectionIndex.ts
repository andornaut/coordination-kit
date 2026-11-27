/** Disposable keyed rows derived from the authoritative event journal. */
export type Cell = string | number | null;
export type ProjectionRow = Readonly<Record<string, Cell>>;
type Table = Map<string, ProjectionRow>;
type Undo = { readonly table: Table; readonly key: string; readonly prior: ProjectionRow | undefined };

export class ProjectionIndex {
  readonly #tables = new Map<string, Table>();
  #undo: Undo[] | undefined;

  get(table: string, key: readonly Cell[]): ProjectionRow | undefined {
    return this.#tables.get(table)?.get(JSON.stringify(key));
  }

  rows(table: string): readonly ProjectionRow[] {
    return [...(this.#tables.get(table)?.values() ?? [])];
  }

  put(table: string, key: readonly Cell[], row: ProjectionRow): void {
    let entries = this.#tables.get(table);
    if (entries === undefined) {
      entries = new Map();
      this.#tables.set(table, entries);
    }
    const encoded = JSON.stringify(key);
    this.#undo?.push({ key: encoded, prior: entries.get(encoded), table: entries });
    entries.set(encoded, Object.freeze({ ...row }));
  }

  remove(table: string, key: readonly Cell[]): void {
    const entries = this.#tables.get(table);
    const encoded = JSON.stringify(key);
    const prior = entries?.get(encoded);
    if (entries !== undefined && prior !== undefined) {
      this.#undo?.push({ key: encoded, prior, table: entries });
      entries.delete(encoded);
    }
  }

  /** A failed journal transaction leaves the disposable index at the previous revision. */
  transaction<T>(run: () => T): T {
    if (this.#undo !== undefined) {
      return run();
    }
    const undo: Undo[] = [];
    this.#undo = undo;
    try {
      return run();
    } catch (error) {
      for (let offset = undo.length - 1; offset >= 0; offset--) {
        const { key, prior, table } = undo[offset]!;
        if (prior === undefined) {
          table.delete(key);
        } else {
          table.set(key, prior);
        }
      }
      throw error;
    } finally {
      this.#undo = undefined;
    }
  }
}
