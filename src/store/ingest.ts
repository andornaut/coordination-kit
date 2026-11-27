// `events ingest`: the runner's per-game event log into the store. The runner is the only writer of
// `var/games/<g>/bus/events.jsonl` and rotates it to `events.<epochSeconds>.jsonl`; this module is
// the only reader. It reads from the cursor, quarantines complete malformed lines, never consumes
// an unterminated last line, commits the events and their messages (runner events and COMPLETE) in
// one transaction, then writes the cursor and only after that deletes rotated files it passed.
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import type { ReasonToken, SeamStatus } from "../core/cli/outcome.ts";
import type { GameLayout, Layout } from "../core/configuration/layout.ts";
import { writeDurable } from "../core/files/durable.ts";
import { holdLock, LockBusy, type LockHandle } from "../core/files/lock.ts";
import { Store, type StoreContext } from "./db.ts";
import { REF, sha256 } from "./eventCodec.ts";
import {
  clean,
  derivedId,
  INTERMEDIATE_TYPES,
  type Notice,
  reportsRecipient,
  shouldNotifyRunnerEvent,
  storeNotice,
} from "./messages/notices.ts";
import { type WakePorts, wakeRecipient } from "./messages/wake.ts";
import { DELIVERY_KIT_ACTOR } from "./sessions/identity.ts";
import type { Json, JsonObject, MessageLink } from "./types.ts";

export const LOG_FILE = "events.jsonl";
export const CURSOR_FILE = "events.cursor";
export const QUARANTINE_FILE = "events.quarantine.jsonl";
const LOCK_FILE = "events.ingest.lock";
const ROTATED = /^events\.(\d{1,12})\.jsonl$/;

export const EVENT_KINDS: ReadonlySet<string> = new Set([
  "attempt",
  "gate",
  "push",
  "ci",
  "deploy",
  "runner",
]);
export const EVENT_STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "failed",
  "blocked",
  "skipped",
  "timeout",
]);
/** The imported legacy `complete` line: that commit's COMPLETE. */
const LEGACY_COMPLETE = "complete";

/** One runner event line, as the contract defines it. */
export interface BusLine {
  readonly schema: 1;
  readonly id: string;
  readonly game: string;
  readonly kind: string;
  readonly type: string;
  readonly key: string;
  readonly at: string;
  readonly sha: string | null;
  readonly status: string | null;
  readonly detail: string | null;
  readonly work: readonly string[] | null;
}

/** The event identity: sha256 of `${game}\n${type}\n${key}`. */
export function busEventId(game: string, type: string, key: string): string {
  return sha256(`${game}\n${type}\n${key}`);
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Normalise either schema-1 identity spelling before hashing or persisting the event. */
export function parseBusLine(game: string, text: string): BusLine | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const work = v.work;
  if (
    v.schema !== 1 ||
    (v.game === undefined && v.appId === undefined) ||
    (v.game !== undefined && v.game !== game) ||
    (v.appId !== undefined && v.appId !== game) ||
    typeof v.kind !== "string" ||
    !EVENT_KINDS.has(v.kind) ||
    typeof v.type !== "string" ||
    !TYPE.test(v.type) ||
    typeof v.key !== "string" ||
    v.key === "" ||
    v.key.length > 1024 ||
    typeof v.at !== "string" ||
    !Number.isFinite(Date.parse(v.at)) ||
    !(v.sha === null || (typeof v.sha === "string" && SHA.test(v.sha))) ||
    !(v.status === null || (typeof v.status === "string" && EVENT_STATUSES.has(v.status))) ||
    !(v.detail === null || typeof v.detail === "string") ||
    !(
      work === null ||
      (Array.isArray(work) && work.every((id) => typeof id === "string" && REF.test(id)))
    ) ||
    v.id !== busEventId(game, v.type, v.key)
  ) {
    return null;
  }
  return {
    at: v.at,
    detail: v.detail as string | null,
    game,
    id: v.id,
    key: v.key,
    kind: v.kind,
    schema: 1,
    sha: v.sha as string | null,
    status: v.status as string | null,
    type: v.type,
    work: work as readonly string[] | null,
  };
}

/** `bus/events.cursor`: the live file's identity and how far ingest has committed. */
export interface Cursor {
  readonly schema: 1;
  readonly file: string;
  readonly offset: number;
  readonly lines: number;
  readonly lastId: string | null;
  readonly firstId: string | null;
  readonly inode: number | null;
  readonly dev: number | null;
  readonly at: string;
}

const CURSOR_KEYS = [
  "at",
  "dev",
  "file",
  "firstId",
  "inode",
  "lastId",
  "lines",
  "offset",
  "schema",
];

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function nullableId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/.test(value));
}

/** The cursor, undefined when absent; throws when it cannot be read or is malformed. */
export function readCursor(busDir: string): Cursor | undefined {
  const path = join(busDir, CURSOR_FILE);
  if (!existsSync(path)) {
    return undefined;
  }
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== CURSOR_KEYS.join(",") ||
    v.schema !== 1 ||
    v.file !== LOG_FILE ||
    !count(v.offset) ||
    !count(v.lines) ||
    !nullableId(v.lastId) ||
    !nullableId(v.firstId) ||
    !(v.inode === null || count(v.inode)) ||
    !(v.dev === null || count(v.dev)) ||
    typeof v.at !== "string"
  ) {
    throw new Error("cursor is malformed");
  }
  return v as unknown as Cursor;
}

function writeCursor(busDir: string, cursor: Cursor): void {
  writeDurable(
    join(busDir, CURSOR_FILE),
    `${JSON.stringify(
      Object.fromEntries([
        ["schema", 1],
        ["file", cursor.file],
        ["offset", cursor.offset],
        ["lines", cursor.lines],
        ["lastId", cursor.lastId],
        ["firstId", cursor.firstId],
        ["inode", cursor.inode],
        ["dev", cursor.dev],
        ["at", cursor.at],
      ]),
    )}\n`,
  );
}

interface LogFile {
  readonly name: string;
  readonly rotated: boolean;
  readonly bytes: Buffer;
  readonly inode: number;
  readonly dev: number;
  /** The id of the first line, null when the file has no complete valid first line. */
  readonly firstId: string | null;
}

function firstLineId(game: string, bytes: Buffer): string | null {
  const end = bytes.indexOf(0x0a);
  return end < 0 ? null : (parseBusLine(game, bytes.subarray(0, end).toString("utf8"))?.id ?? null);
}

/** Read the whole file through one descriptor, so its bytes and identity belong together. */
function readLog(game: string, path: string, name: string, rotated: boolean): LogFile | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const bytes = readFileSync(fd);
    return {
      bytes,
      dev: Number(stat.dev),
      firstId: firstLineId(game, bytes),
      inode: Number(stat.ino),
      name,
      rotated,
    };
  } finally {
    closeSync(fd);
  }
}

function sameFile(a: Pick<LogFile, "inode" | "dev">, b: Pick<LogFile, "inode" | "dev">): boolean {
  return a.inode === b.inode && a.dev === b.dev;
}

/** Rotated files oldest first, excluding the one already open as the live file. */
function rotatedLogs(game: string, busDir: string, live: LogFile | null): LogFile[] {
  return readdirSync(busDir)
    .map((name) => ({ epoch: ROTATED.exec(name)?.[1], name }))
    .filter((entry): entry is { epoch: string; name: string } => entry.epoch !== undefined)
    .sort((a, b) => Number(a.epoch) - Number(b.epoch) || (a.name < b.name ? -1 : 1))
    .map((entry) => readLog(game, join(busDir, entry.name), entry.name, true))
    .filter((file): file is LogFile => file !== null && (live === null || !sameFile(file, live)));
}

/** A resumable offset: within the file and at a line boundary. */
function boundary(file: LogFile, offset: number): boolean {
  return offset <= file.bytes.length && (offset === 0 || file.bytes[offset - 1] === 0x0a);
}

interface Start {
  /** Index into the ordered files of the first file to read. */
  readonly index: number;
  readonly offset: number;
  /** Lines already counted in that file when it is the live file. */
  readonly lines: number;
}

/**
 * Where to resume. The live file matches the cursor by its first line's id. A file whose first
 * line is absent, torn or malformed has no first id; a cursor without one matches only a live
 * file that also has none and the same inode and dev. Otherwise the rotated file whose first line id equals
 * the cursor's is finished from the offset. With no match every file is read from 0, which the
 * store's unique key makes safe.
 */
function resolveStart(files: readonly LogFile[], cursor: Cursor | undefined): Start {
  if (cursor === undefined) {
    return { index: 0, lines: 0, offset: 0 };
  }
  const live = files.at(-1);
  if (
    live !== undefined &&
    !live.rotated &&
    (cursor.firstId === null
      ? live.firstId === null &&
        cursor.inode !== null &&
        cursor.dev !== null &&
        sameFile(live, { dev: cursor.dev, inode: cursor.inode })
      : live.firstId === cursor.firstId) &&
    boundary(live, cursor.offset)
  ) {
    return { index: files.length - 1, lines: cursor.lines, offset: cursor.offset };
  }
  if (cursor.firstId !== null) {
    const index = files.findIndex((file) => file.rotated && file.firstId === cursor.firstId);
    if (index >= 0 && boundary(files[index]!, cursor.offset)) {
      return { index, lines: 0, offset: cursor.offset };
    }
  }
  return { index: 0, lines: 0, offset: 0 };
}

export interface IngestResult {
  readonly status: SeamStatus;
  readonly reason: ReasonToken | null;
  readonly detail: string;
  /** Valid lines this call committed to the store; lines already stored are not counted. */
  readonly delivered: number;
  /** 1 when an unterminated last line awaits its terminator, else 0. */
  readonly held: number;
  /** Complete lines the cursor moved past: committed, already stored or quarantined. */
  readonly ingested: number;
  readonly quarantined: number;
  /** COMPLETE messages this call stored. */
  readonly completed: number;
}

export interface IngestContext extends StoreContext {
  readonly layout: Layout;
  readonly ports?: WakePorts;
  /** Test hook: a step between opening the live file and listing rotations. */
  readonly afterOpenLive?: () => void;
}

function result(
  status: SeamStatus,
  reason: ReasonToken | null,
  detail: string,
  counts: Partial<Omit<IngestResult, "status" | "reason" | "detail">> = {},
): IngestResult {
  return {
    completed: counts.completed ?? 0,
    delivered: counts.delivered ?? 0,
    detail,
    held: counts.held ?? 0,
    ingested: counts.ingested ?? 0,
    quarantined: counts.quarantined ?? 0,
    reason,
    status,
  };
}

function eventNotice(project: string, to: string, line: BusLine): Notice {
  const status = line.status === null ? "" : ` ${line.status}`;
  const sha = line.sha === null ? "" : ` ${line.sha.slice(0, 12)}`;
  const head = `${project} bus: ${line.type}${status}${sha}`;
  const links: MessageLink[] = [{ kind: "event", ref: line.id }];
  if (line.sha !== null) {
    links.push({ kind: "commit", ref: line.sha });
  }
  return {
    body: line.detail === null || line.detail === "" ? head : `${head}: ${clean(line.detail)}`,
    fallback: `${head}: detail withheld because it matches a secret shape`,
    id: derivedId("bus-event", line.id),
    links,
    to,
  };
}

interface EventRow {
  readonly kind: string;
  readonly type: string;
  readonly status: string | null;
  readonly work: string | null;
  readonly detail?: string;
}

function workIds(value: string | null): string[] | null {
  const parsed = value === null ? null : (JSON.parse(value) as Json);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
}

/**
 * Derive the commit's COMPLETE once per (game, sha): gate ok or skipped, push ok, ci ok and deploy
 * ok or skipped (`deploy_disabled` for a game without deployment), or an imported legacy
 * `complete` line. A COMPLETE already delivered under 1.x (an imported message naming the commit)
 * is recorded without a new message. Each work ID is recorded once per game: the first COMPLETE
 * that lists it keeps it. Returns true when a COMPLETE message was stored.
 */
function deriveComplete(
  store: Store,
  game: GameLayout,
  to: string,
  sha: string,
  details: ReadonlyMap<string, string | null>,
): boolean {
  const done = store.db
    .prepare("SELECT 1 FROM bus_completes WHERE game = ? AND sha = ?")
    .get(game.id, sha);
  if (done !== undefined) {
    return false;
  }
  const rows = store.db
    .prepare(
      "SELECT id, kind, type, status, work FROM bus_events WHERE game = ? AND sha = ? ORDER BY seq",
    )
    .all(game.id, sha) as unknown as (EventRow & { id: string })[];
  const legacy = rows.find(
    (row) => row.type === LEGACY_COMPLETE && row.kind === "runner" && row.status === "ok",
  );
  // Progress types never count as success; gate_passed and the docs-only gate_skipped do.
  const passed = (kind: string, statuses: readonly string[]) =>
    rows
      .filter(
        (row) =>
          row.kind === kind &&
          row.status !== null &&
          statuses.includes(row.status) &&
          !INTERMEDIATE_TYPES.has(row.type),
      )
      .at(-1);
  const gate = passed("gate", ["ok", "skipped"]);
  const push = passed("push", ["ok"]);
  const ci = passed("ci", ["ok"]);
  const deploy = passed("deploy", ["ok", "skipped"]);
  const derived =
    gate !== undefined && push !== undefined && ci !== undefined && deploy !== undefined;
  if (legacy === undefined && !derived) {
    return false;
  }
  // An imported legacy complete line is the commit's COMPLETE, with its own work list.
  const listed = workIds(legacy === undefined ? deploy!.work : legacy.work);
  const recorded = store.db.prepare("SELECT 1 FROM bus_work WHERE game = ? AND work = ?");
  const work =
    listed === null ? null : listed.filter((id) => recorded.get(game.id, id) === undefined);
  const previous = store.db
    .prepare(
      `SELECT id FROM messages WHERE legacy IS NOT NULL AND to_role = ? AND instr(body, ?) > 0
         AND instr(upper(body), 'COMPLETE') > 0 ORDER BY sent_seq LIMIT 1`,
    )
    .get(to, sha) as { id: string } | undefined;
  let messageId: string | null = previous?.id ?? null;
  let stored = false;
  if (previous === undefined) {
    messageId = derivedId("complete", game.id, sha);
    const workText = work === null ? "unknown" : work.length === 0 ? "none" : work.join(", ");
    const head =
      legacy !== undefined
        ? `${game.name} bus: COMPLETE ${sha}`
        : `${game.name} bus: COMPLETE ${sha}: gate ${gate!.status}, push ok, ci ok, ` +
          `deploy ${deploy!.type} (${deploy!.status})`;
    const legacyDetail = legacy === undefined ? null : (details.get(legacy.id) ?? null);
    const body = `${head}${legacyDetail ? `; ${clean(legacyDetail)}` : ""}; work: ${workText}`;
    stored = storeNotice(store, {
      body,
      fallback: `${head}; work: ${workText}`,
      id: messageId,
      links: [
        { kind: "commit", ref: sha },
        ...(work ?? []).map((id) => ({ kind: "work", ref: id })),
      ],
      to,
    });
  }
  store.append({
    actor: DELIVERY_KIT_ACTOR,
    key: `bus.complete:${game.id}:${sha}`,
    kind: "bus.complete",
    payload: {
      game: game.id,
      messageId,
      sha,
      source:
        previous !== undefined
          ? "legacy-message"
          : legacy !== undefined
            ? "legacy-line"
            : "derived",
      work: work as unknown as Json,
    },
  });
  return stored;
}

interface Consumed {
  readonly valid: BusLine[];
  readonly malformed: Buffer[];
  readonly lastId: string | null;
  /** The live file's committed offset and line count after this call. */
  readonly liveOffset: number;
  readonly liveLines: number;
  readonly held: number;
}

function consume(game: string, files: readonly LogFile[], start: Start): Consumed {
  const valid: BusLine[] = [];
  const malformed: Buffer[] = [];
  let lastId: string | null = null;
  let liveOffset = 0;
  let liveLines = 0;
  let held = 0;
  for (let index = start.index; index < files.length; index += 1) {
    const file = files[index]!;
    let offset = index === start.index ? start.offset : 0;
    let lines = index === start.index ? start.lines : 0;
    while (offset < file.bytes.length) {
      const end = file.bytes.indexOf(0x0a, offset);
      if (end < 0) {
        if (!file.rotated) {
          // An unterminated last line of the live file is never consumed.
          held = 1;
          break;
        }
        // A rotated file has no writer left to terminate its tail.
        malformed.push(file.bytes.subarray(offset));
        offset = file.bytes.length;
        lines += 1;
        lastId = null;
        break;
      }
      const raw = file.bytes.subarray(offset, end);
      const line = parseBusLine(game, raw.toString("utf8"));
      if (line === null) {
        malformed.push(raw);
        lastId = null;
      } else {
        valid.push(line);
        lastId = line.id;
      }
      offset = end + 1;
      lines += 1;
    }
    if (!file.rotated) {
      liveOffset = offset;
      liveLines = lines;
    }
  }
  return { held, lastId, liveLines, liveOffset, malformed, valid };
}

function appendQuarantine(busDir: string, lines: readonly Buffer[]): void {
  if (lines.length === 0) {
    return;
  }
  const fd = openSync(join(busDir, QUARANTINE_FILE), "a", 0o600);
  try {
    const bytes = Buffer.concat(lines.flatMap((line) => [line, Buffer.from("\n")]));
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Ingest the game's event log once. Lock contention defers without reading. */
export async function ingestEvents(
  context: IngestContext,
  game: GameLayout,
): Promise<IngestResult> {
  const { busDir } = game;
  const hasLog =
    existsSync(busDir) &&
    readdirSync(busDir).some((name) => name === LOG_FILE || ROTATED.test(name));
  if (!hasLog) {
    return result("skipped", "no-events", "no event log");
  }
  let lock: LockHandle;
  try {
    lock = holdLock(join(busDir, LOCK_FILE), { nonBlocking: true });
  } catch (error) {
    if (error instanceof LockBusy) {
      return result("deferred", "recipient-busy", "another events ingest holds its lock");
    }
    throw error;
  }
  try {
    let cursor: Cursor | undefined;
    try {
      cursor = readCursor(busDir);
    } catch {
      return result("deferred", "outbox-unreadable", "bus/events.cursor is unreadable");
    }
    let to: string;
    try {
      to = reportsRecipient(context.layout, game);
    } catch {
      return result("deferred", "recipient-unavailable", "reports.recipient does not resolve");
    }
    // The live file is opened before rotations are listed, so a rotation in between is seen
    // once: as the open live file, never as a rotated file as well.
    const live = readLog(game.id, join(busDir, LOG_FILE), LOG_FILE, false);
    context.afterOpenLive?.();
    const files = [...rotatedLogs(game.id, busDir, live), ...(live === null ? [] : [live])];
    const start = resolveStart(files, cursor);
    const consumed = consume(game.id, files, start);
    const ingested = consumed.valid.length + consumed.malformed.length;
    const store = Store.forLayout(context, context.layout);
    let delivered = 0;
    let completed = 0;
    let notified = false;
    try {
      store.transaction(() => {
        const touched = new Set<string>();
        const details = new Map<string, string | null>();
        for (const line of consumed.valid) {
          const appended = store.append({
            actor: DELIVERY_KIT_ACTOR,
            key: `bus.event:${line.id}`,
            kind: "bus.event",
            payload: line as unknown as JsonObject,
          });
          if (appended.duplicate) {
            continue;
          }
          delivered += 1;
          details.set(line.id, line.detail);
          if (line.sha !== null) {
            touched.add(line.sha);
          }
          // The legacy complete line contributes its own COMPLETE, never a separate notice.
          if (line.type !== LEGACY_COMPLETE && shouldNotifyRunnerEvent(line.type, line.status)) {
            notified = storeNotice(store, eventNotice(game.name, to, line)) || notified;
          }
        }
        for (const sha of touched) {
          if (deriveComplete(store, game, to, sha, details)) {
            completed += 1;
            notified = true;
          }
        }
      });
      if (notified) {
        await wakeRecipient(
          {
            env: context.env,
            layout: context.layout,
            store,
            ...(context.ports === undefined ? {} : { ports: context.ports }),
          },
          to,
        );
      }
    } finally {
      store.close();
    }
    appendQuarantine(busDir, consumed.malformed);
    const next: Cursor = {
      at: context.clock().toISOString(),
      dev: live?.dev ?? null,
      file: LOG_FILE,
      firstId: live?.firstId ?? null,
      inode: live?.inode ?? null,
      lastId: consumed.lastId ?? (ingested === 0 ? (cursor?.lastId ?? null) : null),
      lines: consumed.liveLines,
      offset: consumed.liveOffset,
      schema: 1,
    };
    const rotated = files.filter((file) => file.rotated);
    if (
      cursor === undefined ||
      ingested > 0 ||
      rotated.length > 0 ||
      next.offset !== cursor.offset ||
      next.firstId !== cursor.firstId ||
      next.inode !== cursor.inode ||
      next.dev !== cursor.dev
    ) {
      writeCursor(busDir, next);
    }
    // The cursor now names the live file, so every rotated file is behind it and committed.
    for (const file of rotated) {
      try {
        unlinkSync(join(busDir, file.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    const counts = {
      completed,
      delivered,
      held: consumed.held,
      ingested,
      quarantined: consumed.malformed.length,
    };
    const detail =
      `ingested ${ingested} (${delivered} new, ${consumed.malformed.length} quarantined), ` +
      `completed ${completed}${consumed.held === 1 ? ", torn last line held" : ""}`;
    if (delivered > 0) {
      return result("delivered", null, detail, counts);
    }
    if (consumed.held === 1) {
      return result("deferred", "in-flight", detail, counts);
    }
    return result("skipped", "no-events", detail, counts);
  } finally {
    lock.release();
  }
}
