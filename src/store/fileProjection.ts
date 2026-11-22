import type { DatabaseSync } from "node:sqlite";

import type { Json, StoredEvent } from "./types.ts";

export interface FileRecord {
  readonly path: string;
  readonly data: Json;
}

export interface FileJournalReader {
  events(afterSeq?: number): StoredEvent[];
}

export interface FileJournalWriter extends FileJournalReader {
  commit(events: readonly StoredEvent[], records?: readonly FileRecord[]): void;
}

/** The canonical journal owns serialization and publishes a complete transaction. */
export interface FileJournalPort extends FileJournalReader {
  withWriter<T>(body: (writer: FileJournalWriter) => T): T;
}

export interface FileProjection {
  readonly journal: FileJournalPort;
  readonly records: (
    index: DatabaseSync,
    previousSeq: number,
    events: readonly StoredEvent[],
  ) => readonly FileRecord[];
}
