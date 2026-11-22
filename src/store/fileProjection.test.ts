import { describe, expect, it } from "vitest";

import { MEMORY, Store } from "./db.ts";
import type { FileJournalWriter, FileProjection, FileRecord } from "./fileProjection.ts";
import { messageStatus, sendMessage } from "./messages.ts";
import type { StoredEvent } from "./types.ts";

const ID = "ac4e9456-137f-4f1c-832c-5b7ff64a5d5e";
const ACTOR = { nativeId: null, role: "archies-dog-walks/tech" };

function journal() {
  const events: StoredEvent[] = [];
  const records: FileRecord[] = [];
  let interrupt: "before" | "after" | null = null;
  const read = (after = 0) => events.filter(({ seq }) => seq > after);
  const writer: FileJournalWriter = {
    commit(committed, files = []) {
      const phase = interrupt;
      interrupt = null;
      if (phase === "before") {
        throw new Error("interrupted before publication");
      }
      events.push(...committed);
      records.push(...files);
      if (phase === "after") {
        throw new Error("interrupted after publication");
      }
    },
    events: read,
  };
  const projection: FileProjection = {
    journal: { events: read, withWriter: (body) => body(writer) },
    records: (_index, _previousSeq, batch) =>
      batch.map(({ key, seq }) => ({ data: key, path: `roles/shared/${seq}.json` })),
  };
  return {
    events,
    interruptAt: (phase: typeof interrupt) => {
      interrupt = phase;
    },
    open: () => Store.openFileProjection(MEMORY, projection),
    records,
  };
}

describe("file store query projection", () => {
  it("replays the same events and refreshes again under the writer before reading preconditions", () => {
    const backend = journal();
    const writer = backend.open();
    const reader = backend.open();
    try {
      sendMessage(writer, ACTOR, {
        id: ID,
        body: "Test message",
        intent: "queue",
        to: "coordination-kit",
      });
      expect(reader.head().seq).toBe(0);
      expect(reader.transaction(() => messageStatus(reader, ID).state)).toBe("sent");
      expect(reader.verify()).toEqual(writer.verify());
      expect(backend.records).toHaveLength(1);
    } finally {
      reader.close();
      writer.close();
    }
  });

  it("keeps the index behind a failed commit and deduplicates a recovered committed append", () => {
    const backend = journal();
    const store = backend.open();
    const send = () =>
      sendMessage(store, ACTOR, {
        id: ID,
        body: "Test message",
        intent: "queue",
        to: "coordination-kit",
      });
    try {
      backend.interruptAt("before");
      expect(send).toThrow("before publication");
      expect(store.head().seq).toBe(0);
      expect(backend.events).toHaveLength(0);

      backend.interruptAt("after");
      expect(send).toThrow("after publication");
      expect(store.head().seq).toBe(0);
      expect(send().duplicate).toBe(true);
      expect(messageStatus(store, ID).state).toBe("sent");
      expect(backend.events).toHaveLength(1);
      expect(backend.records).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
