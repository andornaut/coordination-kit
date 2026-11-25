// The /clear lineage proof a Claude transcript carries. A cleared session's transcript
// `<projects>/<project>/<id>.jsonl` opens with one `derived-from` record naming its predecessor.
// Only the header is read: records before the first `user` or `assistant` record, within
// HEADER_LIMIT bytes.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { CONVERSATION_ID_PATTERN } from "../core/validate.ts";

/** The most transcript bytes read for the header. */
const HEADER_LIMIT = 64 * 1024;

/**
 * `$CLAUDE_CONFIG_DIR/projects`, else `$HOME/.claude/projects`; null when the chosen variable is
 * unset or not an absolute path.
 */
export function claudeProjectsDir(env: NodeJS.ProcessEnv): string | null {
  const config = env.CLAUDE_CONFIG_DIR;
  if (config !== undefined && config !== "") {
    return isAbsolute(config) ? join(config, "projects") : null;
  }
  const home = env.HOME;
  return home !== undefined && isAbsolute(home) ? join(home, ".claude", "projects") : null;
}

/** The one regular file `<id>.jsonl` across the project directories; null for none or several. */
function transcriptPath(projectsDir: string, sessionId: string): string | null {
  let projects;
  try {
    projects = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const found = projects
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectsDir, entry.name, `${sessionId}.jsonl`))
    .filter((path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true);
  return found.length === 1 ? found[0]! : null;
}

/** The parsed header records, or null when the header does not end within HEADER_LIMIT. */
function headerRecords(path: string): Record<string, unknown>[] | null {
  const buffer = Buffer.alloc(HEADER_LIMIT + 1);
  const fd = openSync(path, "r");
  let length = 0;
  try {
    let read;
    do {
      read = readSync(fd, buffer, length, buffer.length - length, length);
      length += read;
    } while (read > 0 && length < buffer.length);
  } finally {
    closeSync(fd);
  }
  const complete = length <= HEADER_LIMIT;
  const lines = buffer.subarray(0, Math.min(length, HEADER_LIMIT)).toString("utf8").split("\n");
  if (!complete) {
    // The last line may be cut at the limit.
    lines.pop();
  }
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      continue;
    }
    const { type } = record as { type?: unknown };
    if (type === "user" || type === "assistant") {
      return records;
    }
    records.push(record as Record<string, unknown>);
  }
  return complete ? records : null;
}

/** The `derived-from` predecessor the transcript at `path` proves for `sessionId`, else null. */
function predecessorAt(path: string | null, sessionId: string): string | null {
  let records: Record<string, unknown>[] | null = null;
  try {
    records = path === null ? null : headerRecords(path);
  } catch {
    // An unreadable transcript proves nothing.
  }
  const derived = records?.filter((record) => record.type === "derived-from") ?? [];
  if (derived.length !== 1) {
    return null;
  }
  const [record] = derived as [Record<string, unknown>];
  const sessions = record.sessions;
  if (record.sessionId !== sessionId || !Array.isArray(sessions) || sessions.length !== 1) {
    return null;
  }
  const [entry] = sessions as [unknown];
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const { id, type, via } = entry as { id?: unknown; type?: unknown; via?: unknown };
  return type === "claude_code_session" &&
    via === "clear" &&
    typeof id === "string" &&
    CONVERSATION_ID_PATTERN.test(id) &&
    id !== sessionId
    ? id
    : null;
}

/**
 * The conversation ID `sessionId` was cleared from, proved by its one transcript: exactly one
 * `derived-from` record whose `sessionId` is the caller and whose single `sessions` entry is a
 * `claude_code_session` with `via` `clear` and a valid, different ID. Anything else is null.
 */
export function clearPredecessor(projectsDir: string, sessionId: string): string | null {
  return CONVERSATION_ID_PATTERN.test(sessionId)
    ? predecessorAt(transcriptPath(projectsDir, sessionId), sessionId)
    : null;
}

/**
 * The one conversation cleared from `sessionId`: the only `*.jsonl` transcript in the project
 * directory of `sessionId`'s transcript whose header proves `sessionId` as its `clearPredecessor`.
 * A /clear keeps the project, so no other directory is read. None or several is null.
 */
export function clearSuccessor(projectsDir: string, sessionId: string): string | null {
  if (!CONVERSATION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  const own = transcriptPath(projectsDir, sessionId);
  if (own === null) {
    return null;
  }
  const project = dirname(own);
  let names: string[];
  try {
    names = readdirSync(project);
  } catch {
    return null;
  }
  const successors = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.slice(0, -".jsonl".length))
    .filter(
      (id) =>
        id !== sessionId &&
        CONVERSATION_ID_PATTERN.test(id) &&
        statSync(join(project, `${id}.jsonl`), { throwIfNoEntry: false })?.isFile() === true &&
        predecessorAt(join(project, `${id}.jsonl`), id) === sessionId,
    );
  return successors.length === 1 ? successors[0]! : null;
}
