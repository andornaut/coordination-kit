import type { DatabaseSync } from "node:sqlite";

import type { CheckpointReceipt } from "./files/compactionCheckpoint.ts";
import type { Json, StoredEvent } from "./types.ts";

interface FileRecord {
  readonly path: string;
  readonly data: Json;
}

interface FileJournalReader {
  events(afterSeq?: number): StoredEvent[];
}

interface FileJournalWriter extends FileJournalReader {
  commit(events: readonly StoredEvent[], records?: readonly FileRecord[]): void;
}

/** The canonical journal owns serialization and publishes a complete transaction. */
interface FileJournalPort extends FileJournalReader {
  withWriter<T>(body: (writer: FileJournalWriter) => T): T;
}

export interface FileProjection {
  /** Optional replay prefix and its independently qualified receipt. The journal supplies the tail. */
  readonly checkpoint?: { readonly value: unknown; readonly receipt: CheckpointReceipt };
  readonly journal: FileJournalPort;
  readonly records: (
    index: DatabaseSync,
    previousSeq: number,
    events: readonly StoredEvent[],
  ) => readonly FileRecord[];
}
