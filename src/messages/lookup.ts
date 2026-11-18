// Derived lookup hints beside the message records. A hint is an empty marker file named by the
// record file it points to, so it holds no message data. Hints are written only from a record's
// own immutable recipient and its attempt request IDs. Readers verify every hinted record and
// read every record without a recipient hint, so a missing or dangling hint never changes an
// answer, only what is read. Removing the lookup directory rebuilds it from the records.
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const RECORD = /^[0-9a-f]{64}\.json$/;
const NAME = /^[0-9a-f]{64}$/;

export type MessageHintKind = "recipient" | "request";

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** An unreadable hint directory reads as empty, which only leaves its records uncovered. */
function names(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** The lookup directory is a sibling of the records, outside the migrated record inventory. */
export function messageLookupDirectory(records: string): string {
  return join(dirname(records), "message-index");
}

export class MessageLookup {
  private readonly records: string;
  private readonly root: string;

  constructor(records: string) {
    this.records = records;
    this.root = messageLookupDirectory(records);
  }

  private directory(kind: MessageHintKind, key: string): string {
    return join(this.root, kind, hash(key));
  }

  /** Record base names (without `.json`) currently stored, from one directory listing. */
  stored(): Set<string> {
    let entries: string[];
    try {
      entries = readdirSync(this.records);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Set();
      }
      throw error;
    }
    return new Set(entries.filter((name) => RECORD.test(name)).map((name) => name.slice(0, 64)));
  }

  /** Hinted record base names for one key. Unknown keys have none. */
  hinted(kind: MessageHintKind, key: string): string[] {
    return names(this.directory(kind, key)).filter((name) => NAME.test(name));
  }

  /** Record base names with any recipient hint: every record has exactly one recipient. */
  covered(): Set<string> {
    const covered = new Set<string>();
    for (const key of names(join(this.root, "recipient"))) {
      if (NAME.test(key)) {
        for (const name of names(join(this.root, "recipient", key))) {
          if (NAME.test(name)) {
            covered.add(name);
          }
        }
      }
    }
    return covered;
  }

  /**
   * Best-effort and idempotent: creating an existing marker changes nothing, and a failure only
   * leaves the record uncovered for the next verified read.
   */
  add(kind: MessageHintKind, key: string, record: string): void {
    if (!NAME.test(record)) {
      return;
    }
    try {
      const directory = this.directory(kind, key);
      mkdirSync(directory, { mode: 0o700, recursive: true });
      const path = join(directory, record);
      if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
        closeSync(
          openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600),
        );
      }
    } catch {
      // A missing hint is recovered from the records.
    }
  }
}
