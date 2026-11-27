import { linkSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { eventHash, sha256 } from "../../eventCodec.ts";
import { GENESIS, type StoredEvent } from "../../types.ts";
import { readClosedHistoryCohort, verifyClosedHistoryCohort } from "./closedHistoryCohort.ts";

const OWNER = "sample-app/tech";
const SENDER = "sample-kit";
const ID = "00000000-0000-4000-8000-000000000001";
const BODY = "Synthetic body.";
const BODY_SHA = sha256(BODY);
const AT = "2026-11-20T00:00:00.000Z";

function fixture() {
  const events: StoredEvent[] = [];
  function append(kind: string, role: string, payload: StoredEvent["payload"]) {
    const seq = events.length + 1;
    const event = {
      actor: { nativeId: null, role },
      at: AT,
      key: `${kind}:${seq}`,
      kind,
      payload,
      prevHash: events.at(-1)?.hash ?? GENESIS,
      seq,
    };
    events.push({ ...event, hash: eventHash(event) });
  }
  append("msg.sent", SENDER, { body: BODY, bodySha256: BODY_SHA, id: ID, to: OWNER });
  append("msg.closed", OWNER, { id: ID, state: "handled" });
  const record = {
    count: 1,
    head: { hash: events[1]!.hash, seq: 2 },
    originals: [
      {
        bodySha256: BODY_SHA,
        closeSeq: 2,
        disposition: "handled",
        id: ID,
        originalSeq: 1,
        owner: OWNER,
      },
    ],
    registryRevision: 17,
    schema: 1,
    state: "requested-cohort-not-activation-evidence",
    window: 100,
  };
  const directory = mkdtempSync(join(tmpdir(), "closed-cohort-"));
  const path = join(directory, "cohort.json");
  function save(data: unknown = record) {
    const bytes = `${JSON.stringify(data, null, 2)}\n`;
    writeFileSync(path, bytes);
    return sha256(bytes);
  }
  return { append, directory, events, path, record, save };
}

describe("closed history cohort evidence", () => {
  it("binds exact artifact bytes and original receipts across a compacted prefix and later tail", () => {
    const { append, events, path, record, save } = fixture();
    const sha = save();
    const cohort = readClosedHistoryCohort(path, sha);
    expect(cohort).toEqual({ ...record, sha256: sha });
    expect(JSON.stringify(cohort)).not.toContain(BODY);
    append("work.started", OWNER, { id: "wk-0001" });
    expect(verifyClosedHistoryCohort(cohort, events, 18)).toEqual(new Set([ID]));
    const original = events[0]!;
    events[0] = {
      ...original,
      payload: { bodySha256: BODY_SHA, id: ID, to: OWNER },
    };
    expect(verifyClosedHistoryCohort(cohort, events, 18)).toEqual(new Set([ID]));

    writeFileSync(path, JSON.stringify(record));
    expect(() => readClosedHistoryCohort(path, sha)).toThrow(
      "closed-history-cohort-digest-mismatch",
    );
  });

  it("refuses noncanonical, symlinked and multiply linked artifact paths", () => {
    const { directory, path, save } = fixture();
    const sha = save();
    const alias = join(directory, "alias.json");
    symlinkSync(path, alias);
    expect(() => readClosedHistoryCohort(alias, sha)).toThrow("closed-history-cohort-path-invalid");
    expect(() => readClosedHistoryCohort(`${directory}/./cohort.json`, sha)).toThrow(
      "closed-history-cohort-path-invalid",
    );
    linkSync(path, join(directory, "hardlink.json"));
    expect(() => readClosedHistoryCohort(path, sha)).toThrow("closed-history-cohort-path-invalid");
  });

  it("refuses unrecognized schema, state, window and duplicate or impossible receipts", () => {
    const { path, record, save } = fixture();
    const original = record.originals[0]!;
    for (const data of [
      { ...record, extra: "unexpected" },
      { ...record, schema: 2 },
      { ...record, state: "activation-approved" },
      { ...record, window: 0 },
      { ...record, count: 2 },
      { ...record, count: 2, originals: [original, original] },
      { ...record, originals: [{ ...original, closeSeq: original.originalSeq }] },
      { ...record, originals: [{ ...original, closeSeq: 3 }] },
    ]) {
      expect(() => readClosedHistoryCohort(path, save(data))).toThrow(
        "closed-history-cohort-invalid",
      );
    }
  });

  it("fails closed on a mismatched restored baseline or exact receipt", () => {
    const { append, events, path, record, save } = fixture();
    const cohort = readClosedHistoryCohort(path, save());
    expect(() => verifyClosedHistoryCohort(cohort, events, 16)).toThrow(
      "closed-history-cohort-baseline-mismatch",
    );
    expect(() =>
      verifyClosedHistoryCohort({ ...cohort, head: { hash: GENESIS, seq: 2 } }, events, 17),
    ).toThrow("closed-history-cohort-baseline-mismatch");
    expect(() => verifyClosedHistoryCohort(cohort, [...events].reverse(), 17)).toThrow(
      "closed-history-cohort-baseline-mismatch",
    );
    const original = record.originals[0]!;
    for (const entry of [
      { ...original, owner: SENDER },
      { ...original, disposition: "superseded" },
      { ...original, bodySha256: GENESIS },
    ]) {
      const mismatch = readClosedHistoryCohort(path, save({ ...record, originals: [entry] }));
      expect(() => verifyClosedHistoryCohort(mismatch, events, 17)).toThrow(
        "closed-history-cohort-entry-mismatch",
      );
    }
    append("msg.closed", OWNER, { id: ID, state: "handled" });
    expect(() => verifyClosedHistoryCohort(cohort, events, 17)).toThrow(
      "closed-history-cohort-entry-mismatch",
    );
  });
});
