# Coordination store

The SQLite store behind the `msg`, `inbox` and `work` commands: its schema, the library API, the
writer fence, wakes, the store-mode switch, runner event ingest, work records, the legacy import
mapping, the cutover runbook and rollback. The design is in
[simplification](design/simplification.md#phase-2-one-store-and-one-message-path).

## Location and settings

The store is one file, `coordination.db`, in the active work protocol's state root
(`<stateRoot>/coordination.db`). Without an active protocol (unmanaged, or a required declaration
still pending) it is `var/coordination.db` under the coordinator root. Wake files sit beside it
under `wake/`, as in [review](review.md#wake-files).

It opens through `node:sqlite` (`DatabaseSync`, built into Node 24.21 with no flag) with
`journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000` and `foreign_keys=ON`. A new file is
created with mode 0600 in a 0700 directory. `PRAGMA user_version` holds the schema version, 1; a
newer version is refused with `store-schema-newer`. Every write is one `BEGIN IMMEDIATE`
transaction holding the event and its projection updates. No native call runs inside a
transaction.

## Schema

`events` is append-only; triggers abort any `UPDATE` or `DELETE`.

| Column            | Content                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `seq`             | 1, 2, 3, ... in commit order.                                                                              |
| `key`             | Unique idempotency key, one per command (`msg.sent:<id>`, `msg.closed:<id>`, `msg.imported:<id>`, ...).    |
| `kind`            | Dotted lower-case kind, such as `msg.sent`.                                                                |
| `actor_role`      | The fenced caller's registry role, or null for import-time wakes and maintenance.                          |
| `actor_native_id` | The caller's native conversation ID, or null.                                                              |
| `actor_worker`    | The caller's unverified `--worker` attribution, or null.                                                   |
| `at`              | ISO 8601 UTC time of the write.                                                                            |
| `payload`         | The canonical JSON payload: keys sorted at every depth, no whitespace.                                     |
| `prev_hash`       | The previous event's `hash`; 64 zeros for seq 1.                                                           |
| `hash`            | sha256 of `prev_hash`, a newline and the canonical JSON of `{actor, at, key, kind, payload, schema, seq}`. |

Projections, updated in the same transaction as their event:

- `messages`: one row per message with its sender, recipient, intent, body, `body_sha256`, links,
  state (`sent`, `delivered`, `handled`, `retained` or `superseded`), `unconfirmed`, delivery and
  close times, work ID, superseding ID, evidence, retention and legacy provenance. Indexed by
  `(to_role, state, sent_seq)` and `(from_role, sent_seq)`.
- `wake_state`: per recipient, `pending` (a send since its last pull) and the `outstanding` wake.
- `wakes`: the wake log, one row per claimed or guarded wake with its harness, conversation,
  count, outcome and detail.

- `bus_events`: one row per runner event, unique per (game, type, key), indexed by (game, sha).
- `bus_completes`: one row per (game, sha) COMPLETE with its source, message ID and work IDs.
- `bus_work`: each work ID once per game, with the commit whose COMPLETE first listed it.
- `review_briefs`: one row per (game, slot) stored review brief with its recipient and message ID.

- `work`: one row per (repository, work ID) with its owner, state, parent, start, ready and finish
  times and open block ([work records](#work-records)).
- `work_evidence`: one row per stage record: stage, commit, reference, source and actor.
- `work_retained`: one row per retained item of a work item: owner, reason and next boundary.

Event kinds: `msg.sent`, `msg.imported`, `inbox.read`, `msg.closed`, `msg.retained`,
`wake.claimed`, `wake.completed`, `wake.guarded`, `wake.rearmed`, `bus.event`, `bus.complete`,
`review.brief`, `store.cutover`, `work.started`, `work.evidence`, `work.blocked`,
`work.unblocked`, `work.ready`, `work.finished`, `work.retained` and `hold.imported`. A kind with no projection is still stored and chained, so a
later projection can read it on its next rebuild. A store written before a projection existed
gets that projection's tables when it is opened, filled from the existing events in one
transaction; the events and their hashes are untouched.

`store rebuild` recomputes every hash from seq 1, refuses with `chain-broken` at the first
mismatch, then drops and recreates the projection tables and replays every event in one
transaction. `Store.verify()` is the same check without the rebuild.

## Message lifecycle

1. `msg send` commits the original (ID, sender, recipient, intent, body, body hash, links) as
   `msg.sent` and marks the recipient wake-pending. Nothing native happens before that commit.
2. It then attempts at most one wake (below). The wake outcome never changes message state.
3. The recipient's own `inbox` records every listed `sent` message as `delivered` in one
   `inbox.read` event, which also clears its pending and outstanding wake. A read with nothing
   new and no wake state writes nothing.
4. The recipient closes with one write: `msg done ID` (`handled`, or `superseded` with
   `--superseded-by`), or `msg retain ID` with an owner, reason and next boundary. A retained
   message stays open and can be retained again or closed. A close or retention of a message
   still `sent` also sets its delivery time, since the recipient acted on it.

Only the recipient can deliver, close or retain its own messages (`not-recipient`). Repeating a
send with the same ID and identical content, or the same close, is a no-op reported with
`duplicate: true`; any other reuse is `id-conflict` or `already-closed`. A send without `--id`
gets a fresh UUID, so a retry that must not duplicate passes `--id`.

`msg send` refuses a body over 1 MiB (`body-too-large`) and a body or retention text that matches
a secret shape (`secret-shaped-body`). The shapes favour recall over precision; a refused body
that holds no secret is rephrased:

| Shape             | Matches                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `private-key`     | A PEM or PGP `BEGIN ... PRIVATE KEY` armour line.                                        |
| `github-token`    | `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` and 36 or more alphanumerics; `github_pat_...`. |
| `anthropic-key`   | `sk-ant-` and 20 or more key characters.                                                 |
| `openai-key`      | `sk-`, optionally `proj-` or `svcacct-`, and 32 or more key characters.                  |
| `aws-access-key`  | `AKIA` or `ASIA` and 16 upper-case alphanumerics.                                        |
| `google-api-key`  | `AIza` and 35 key characters.                                                            |
| `slack-token`     | `xoxa-`, `xoxb-`, `xoxe-`, `xoxo-`, `xoxp-`, `xoxr-` or `xoxs-` and 10 or more.          |
| `npm-token`       | `npm_` and 36 alphanumerics.                                                             |
| `jwt`             | Three dot-separated base64url segments, the first two starting `eyJ`.                    |
| `bearer-token`    | `Bearer` followed by 24 or more token characters.                                        |
| `url-credentials` | A URL with a `user:password@` part of 6 or more password characters.                     |

## Writer fence

Every writing verb (`msg send`, `inbox`, `msg done`, `msg retain`, `store import` and the `work`
writes) resolves its
caller before it opens the store: the caller is the registry role whose effective harness
conversation ID equals the caller's native ID. The native ID is `--native-id ID`, else, for each
role, the variable of that role's effective harness: `CLAUDE_CODE_SESSION_ID` for Claude and
`CODEX_THREAD_ID` for Codex. A Claude ID in `CODEX_THREAD_ID`, or the reverse, binds nothing.

| Refusal               | Cause                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| `caller-unidentified` | No `--native-id` and neither variable set.                                      |
| `caller-unbound`      | No role's effective binding equals the native ID.                               |
| `caller-ambiguous`    | More than one role matches, such as both variables set and each binding a role. |
| `invalid-native-id`   | `--native-id` is not a canonical UUID.                                          |

`harness select` rotates the binding, so the fence follows it with no other step. There are no
epochs, claims or enrollment. Every send reads `var/registry.json`; nothing is cached.

A worker writes under its parent's binding. `--worker NAME` records an attribution beside the
role on the event and the message. It is not verified: any caller bound to the role may name any
worker, so it is a label for reading history, not an identity.

Reads (`msg status`, `msg history`, `store export`, `store rebuild`, `store import --dry-run`,
`work show` and `work history`) take no caller.

## Wakes

A wake carries no payload. Its only text is `N new messages for ROLE: run coordination-kit inbox`,
where `N` counts the recipient's `sent` messages.

- Claude: the store writes the conversation's wake file through `writeWakeFile`, which advances
  `seq` by one; the channel coalesces increases between polls.
- Codex: one control-socket `thread/queue/add` through the existing guarded queue path, with a
  receipt at `wake/codex/<wake-id>.json` beside the store.

At most one wake is outstanding per recipient. A wake is attempted only when the recipient is
wake-pending, has `sent` messages and has no outstanding wake. Before claiming it, the store
checks the registry: an unregistered, unbound or held recipient (`ownership` not `active`, or
`phase` `held` or `source-held`) gets no wake. For Codex the guarded queue path also requires the
recipient-bound decision marker and runs the native question check on the same connection.
A guard refusal is logged as `guarded`, leaves nothing outstanding, and the next send checks
again. An accepted wake stays outstanding until the recipient's next pull. A failed or ambiguous
wake is logged and stays outstanding: it is not retried before the recipient's next pull or the
next review, which may call `rearmWake`. A wake interrupted between its claim and its outcome
stays outstanding with no outcome, which reads as ambiguous.

Until the store's question and hold records ship, the `storeGuard` port of `wakeRecipient` passes
every recipient; their projection supplies one that blocks on an open question or hold record.

## Store mode

The store is the selected mode when both hold:

1. `var/work-protocol-fence.json` is a store cutover fence (`"kind": "store-cutover"`), which only
   `store cutover --apply` writes; and
2. `coordination.db` exists at the store path.

A cutover fence without the store is refused with `store-missing`, since legacy writers are fenced
and the store cannot be read. Without the cutover fence every path behaves as in 1.3. In store
mode:

- `review deliver` stores the brief as one message ([review](review.md#stored-brief)); it sends no
  native brief and spools nothing.
- Events this kit produces itself (review health such as `review-stuck`) are stored as messages
  from `delivery-kit` to the game's `reports.recipient`, with IDs derived from (game, kind, key).
  They never go to the event outbox or the runner's `events.jsonl`. The recipient is woken by the
  next send to it or the next review.
- Legacy message writes (`message send`, `dispatch`, `reconcile`, `retire-spool` and every other
  write through the legacy message store) are refused with `store-cutover`; legacy reads such as
  `message status` read the frozen records. `claude channel` stops draining the generic message
  spool, whose unclaimed entries were imported as `sent`; game spools still drain.
- `events flush` and the event outbox are unchanged, for 6.0 runners.

The switch is the fence, not a setting in `config.json`, so a 1.3 CLI never sees a field it does
not know. Restoring the previous fence switches this kit back to legacy mode and lets a 1.3 CLI
run again.

### Cutover fence

```json
{
  "schema": 1,
  "kind": "store-cutover",
  "generation": 2,
  "cutoverAt": "2026-11-19T20:40:00.000Z",
  "previous": { "schema": 1, "workspaceId": "W", "stateRoot": "/abs", "generation": 1 }
}
```

`previous` is the fence it replaced: the active work protocol configuration, or `null` when the
coordinator is unmanaged. `generation` is one above the previous generation (1 when unmanaged).
The configuration file and `<stateRoot>/workspace.json` keep the previous generation, so role
epochs and enrollment are untouched.

- This kit resolves the previous selection unchanged from `previous`, so the state root and the
  store path do not move.
- A 1.3 CLI requires the fence to equal the configuration (or, unmanaged, to be absent or a
  pending fence), so every 1.3 command that resolves the protocol selection fails closed with
  `protocol-generation-conflict` (or `protocol-fenced` when unmanaged). Runners that bundle a 1.x
  copy see the same refusal in their protocol reads; departures do not depend on it.

## Runner events

`events ingest --game G` reads the runner's per-game log into the store. The runner is the only
writer of `var/games/<g>/bus/events.jsonl` (one JSON object per line, `\n`-terminated, one
`O_APPEND` write under 4096 bytes) and rotates it to `events.<epochSeconds>.jsonl` when the cursor
offset equals its size and the size exceeds 1 MiB. Ingest is the only reader:

```json
{
  "schema": 1,
  "id": "sha256(game\ntype\nkey)",
  "game": "G",
  "kind": "deploy",
  "type": "deploy_success",
  "key": "K",
  "at": "ISO",
  "sha": "40 hex or null",
  "status": "ok",
  "detail": "TEXT or null",
  "work": ["ck-0017"]
}
```

- `kind` is `attempt`, `gate`, `push`, `ci`, `deploy` or `runner`; `status` is `ok`, `failed`,
  `blocked`, `skipped`, `timeout` or `null` for a type with no outcome (such as `attempt` or
  `runner.started`); `type` is the exact legacy kind string, such as
  `ci_success` or `blocked-full-gate`. A line whose `id` is not the sha256 of
  `${game}\n${type}\n${key}`, whose `game` is another game, or that is not valid JSON in this
  shape is malformed.
- Each complete malformed line is appended to `bus/events.quarantine.jsonl` and skipped. An
  unterminated last line of `events.jsonl` is never consumed; the runner terminates a torn tail at
  start and after a failed append. A rotated file has no writer left, so its unterminated tail is
  quarantined.
- Each valid line is committed once as a `bus.event` event with the unique key
  `bus.event:<id>`, unique per (game, type, key). Blocked events stay apart per type.
- Every non-quiet event is also stored as a message from `delivery-kit` to `reports.recipient`
  with an ID derived from the event ID. The quiet progress types (`ci_pending`, `ci_running`,
  `deploy_pending`, `deploy_retry` and `gate_skipped`) are stored as events only.
- The events, their messages and any COMPLETE are one transaction. Then the recipient is woken,
  quarantined lines are appended, the cursor is written atomically, and only then are rotated
  files the cursor has passed deleted.

### COMPLETE

A commit's COMPLETE is derived once per (game, sha), as a `bus.complete` event with the key
`bus.complete:<game>:<sha>` and a message to `reports.recipient` whose ID derives from (game,
sha). It fires when, for that sha, a gate passed (`ok`, or `skipped` for the docs-only
`gate_skipped`), a push and CI are `ok`, and a deploy is `ok` or `skipped` (`deploy_disabled` for a
game without deployment). Other progress types never count. The synthetic `push` line a 6.1 runner
appends at its first start (detail `imported at 6.1 start`) is a normal push. Ingest never reads
the game's delivery configuration.

- `work` comes from the passing deploy event: the IDs whose work file became `status: done` since
  the previous COMPLETE, `[]` for none and `null` for unknown. Each work ID is recorded once per
  game; the first COMPLETE that lists it keeps it, and later ones leave it out.
- An imported legacy `complete` line (type `complete`, kind `runner`, status `ok`) is that sha's
  COMPLETE, with its own detail and `work`, and sends no separate event message.
- A COMPLETE already delivered under 1.x, an imported legacy message to the recipient that names
  the commit and `COMPLETE`, is recorded with that message's ID and no new message.

### Cursor

`bus/events.cursor` is written atomically after every commit:

```json
{
  "schema": 1,
  "file": "events.jsonl",
  "offset": 0,
  "lines": 0,
  "lastId": null,
  "firstId": null,
  "inode": 0,
  "dev": 0,
  "at": "ISO"
}
```

`offset` and `lines` are what ingest has committed of the live file; `lastId` is the last consumed
line's id (null when it was malformed); `firstId` is the id of the live file's first line, and
`inode` and `dev` its identity. The runner computes `drained` (offset equals size, no rotated
files, no torn line) from it without reading the store.

Ingest opens the live file before listing rotated files, so a rotation in between is read once,
through the open descriptor. It then resumes:

1. In the live file at `offset` when its first line's id equals `firstId`. A file whose first line
   is absent, torn or malformed has no first id: a cursor whose `firstId` is null matches only a
   live file that also has none and the same inode and dev.
2. Otherwise in the rotated file whose first line id equals `firstId`, finished from `offset`,
   then the newer rotated files and the live file from 0.
3. Otherwise every rotated file and the live file from 0, which the unique key makes safe.

### Result

`events ingest` prints one line with the `events flush` keys and three counts, and the same exit
codes (0 for every typed result, 2 for a usage error, 1 for an internal failure):

```json
{
  "schema": 1,
  "kind": "events-ingest",
  "game": "G",
  "status": "delivered",
  "reason": null,
  "detail": "TEXT",
  "delivered": 3,
  "held": 0,
  "ingested": 4,
  "quarantined": 1,
  "completed": 1,
  "cli": { "version": "2.0.0", "distSha256": "HEX" }
}
```

- `delivered`: valid lines this call committed; lines already stored are not counted.
- `held`: 1 when an unterminated last line awaits its terminator, else 0.
- `ingested`: complete lines the cursor moved past, whether committed, already stored or
  quarantined. `quarantined`: malformed lines; `completed`: COMPLETE messages stored.
- `status` is `delivered` when `delivered` is above 0; else `deferred` with `in-flight` while a
  torn last line is held; else `skipped` with `no-events`. Lock contention is `deferred` with
  `recipient-busy`; an unreadable cursor is `deferred` with `outbox-unreadable`; a
  `reports.recipient` that does not resolve is `deferred` with `recipient-unavailable`. None of
  these consumes anything.

## Work records

Approval, owner, scope, criteria and decisions stay in `docs/work/<id>.md` on the repository's
`main`; the store holds each item's live progress, keyed by (repository, work ID). The repository
is the registered repository that holds `--root` (default: the working directory), named as
[`status`](commands.md#status) names it: the game or kit ID, `game-coordinator`, or the directory
name. The coordinator comes only from `COORDINATION_KIT_ROOT`, else `DELIVERY_KIT_ROOT`
(`coordinator-unset` otherwise).

The owner of an item is its front-matter `owner`, which must be one of the repository's roles;
else the repository's only role; else, in a game, the role named by the item's `design` area
(`<game>/<area>`), then the game's Tech role. Every write requires the [fenced](#writer-fence)
caller to be that owner (`not-owner`; `owner-unresolved` when no owner applies). The work file is
read from the local `refs/heads/main`, never the working tree (`work-file-missing` when absent).

| Verb                                                   | Event            | Rule                                                                                                                                                          |
| ------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `work start ID [--parent REPOSITORY:WORK_ID]`          | `work.started`   | `status: approved` on `main` (`work-not-approved`), no open hold covers the item (`work-held`). A repeat is a duplicate; another parent is `parent-conflict`. |
| `work evidence ID --stage STAGE --sha SHA [--ref REF]` | `work.evidence`  | `approved` or `done` on `main`. The same stage, commit and reference record once. Allowed after finish, since acceptance stages continue.                     |
| `work block ID --reason TEXT [--owner ROLE]`           | `work.blocked`   | Not finished. `--owner` names the registered role that can clear it. The same open block again is a duplicate.                                                |
| `work unblock ID`                                      | `work.unblocked` | Clears the open block; none open is a duplicate.                                                                                                              |
| `work ready ID`                                        | `work.ready`     | Started (`work-not-started`), not blocked (`work-blocked`), not finished.                                                                                     |
| `work finish ID`                                       | `work.finished`  | `status: done` on `main` (`work-not-done`). Once per item; it closes an open block.                                                                           |

Stages are `implemented`, `merged`, `verified`, `published` and `deployed`; a SHA is 7 to 64
lower-case hex digits (upper case is folded). Reasons and references are one line of at most
2000 (references 512) characters and are refused when secret-shaped (`secret-shaped-text`).

`--parent` links a cross-role child request to its parent item in another repository, which must
be registered (`repository-unregistered`) and hold the parent's work file on its `main`
(`parent-missing`). The child stays owned by its own role.

A record's `state` is `finished`, else `blocked`, else `ready`, else `started`, else `recorded` (a
record made only by evidence or import). `work show ID` prints the owner, the work file's status
and title, the record (with its evidence, retained items, parent and children) or null, and the
holds covering the item. `work history ID` prints the item's work events in order.

### Hold seam

`work start` asks a `HoldLookup` port for the open holds covering the item. Until the hold records
ship, the default reads the `hold.imported` events whose `work` list names the item; nothing
releases them. The hold projection supplies the port when it lands and also applies
`hold.imported`, which the approval-ledger import writes:

```json
{
  "id": "approval-ledger:<ledger hold ID>",
  "owner": "ROLE or null",
  "reason": "TEXT",
  "work": [{ "repository": "R", "id": "W" }],
  "entries": ["<ledger entry ID>"],
  "source": "approval-ledger"
}
```

The event key is `hold.imported:approval-ledger:<first 32 hex of sha256(ledger hold ID)>`. An owner
of null means the ledger names no registered owner: no caller can release the hold through the
fence, so game-coordinator surfaces it to the user.

## Library API

`@andornaut/coordination-kit/build/store` exports the store for the later Phase 2 work (events
ingest, briefs as stored messages and the review seam):

- `Store.open(path)`, `Store.forLayout(layout)`, `storePath(layout)` and `storeRoot(layout)`;
  `store.append({key, kind, actor, payload, at?})` returns `{event, duplicate}` and applies the
  projections; `store.transaction(body)` joins nested calls; `store.events({afterSeq, kinds})`,
  `store.head()`, `store.eventByKey(key)`, `store.verify()` and `store.rebuild()`.
- Messages: `sendMessage`, `readInbox`, `closeMessage`, `retainMessage`, `messageStatus`,
  `recipientMessages(store, role, states)`, `messageHistory` and `exportSince`. They trust their
  `Actor`; a caller that is not the CLI resolves it with `resolveCaller(registry, env, options)`
  or passes a role it owns, such as delivery-kit for a stored brief.
- Wakes: `wakeRecipient(context, role)` after a committed send, `wakeState`, `pendingWakeRoles`
  and `rearmWake(store, actor, role, reason)` for the review.
- Projections: `PROJECTIONS` and `MESSAGES_PROJECTION`. A new projection is a `Projection` with
  its tables, DDL and one applier per event kind, appended to `PROJECTIONS`; `rebuild` recreates
  it from the existing events.
- Import: `legacySources`, `mapLegacyRecord` and `importLegacy`.
- Mode and cutover: `storeMode(layout)`, `isStoreMode(layout)`, `storeCutover` and
  `COORDINATOR_ROLE`.
- Runner events: `ingestEvents(context, game)`, `parseBusLine`, `busEventId`, `readCursor`,
  `LOG_FILE`, `CURSOR_FILE`, `QUARANTINE_FILE`, `EVENT_KINDS` and `EVENT_STATUSES`.
- Notices from the runner's role: `DELIVERY_KIT_ROLE`, `DELIVERY_KIT_ACTOR`, `derivedId`,
  `reportsRecipient` and `storeNotice`.
- Projections: `DELIVERY_PROJECTION` and `WORK_PROJECTION` beside `MESSAGES_PROJECTION`.
- Work records: `startWork`, `recordEvidence`, `blockWork`, `unblockWork`, `readyWork`,
  `finishWork`, `retainWorkItem`, `readWorkRecord`, `readWorkRecords`, `workHistory`, `WORK_STAGES`,
  `WORK_KINDS`, the `HoldLookup` seam and its default `importedHolds`. They trust their `Actor`;
  the owner check is the CLI's.
- The CLI services `storeSend`, `storeInbox`, `storeDone`, `storeRetain`, `storeStatus`,
  `storeHistory`, `storeImport`, `storeExport` and `storeRebuild`, and `StoreError` with its
  `code`.

The stored review brief (`storeReview`, `showBrief`, `composeBrief`) and the coordination event
port (`coordinationEmit`) are in `@andornaut/coordination-kit/build/review`.

## Legacy import

`store import --from-legacy` reads the legacy records (`<sha256(id)>.json`, schema 1) from
`<stateRoot>/transport/messages` and, when present, the pre-activation `var/game-dev/messages`. It
never writes, moves or locks them. Each record's envelope must reproduce its stored payload hash
and file name, or it is reported `invalid` and skipped. An ID in both sources is imported once,
from the state root; the other copy is a `duplicate`, flagged `differs-from-earlier-source` when
its mapped content differs.

| Legacy state                                                | Imported as                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `queued`, `blocked`, no attempt                             | `sent`                                                           |
| `accepted`, `parent-required`                               | `delivered` at the accepted attempt's completion                 |
| `sending`, `ambiguous`                                      | `delivered` with `unconfirmed: true`, never woken                |
| `sending`, `ambiguous` with an unclaimed Claude spool entry | `sent`, since the consumer never took it                         |
| `handled`, `superseded`                                     | closed in that state with every evidence reference as `kind:ref` |
| `retained`, `held`                                          | `retained` with the legacy owner, reason and next boundary       |

An unconfirmed message is listed to its recipient on every pull until closed; the recipient alone
can say whether it acted. The import keeps the original ID, body, `body_sha256`, the legacy
payload hash and state (`legacy`), and a worker target as a `worker-target` link. Legacy close
times are not recorded, so `closedAt` is null.

`--dry-run` takes no caller, writes nothing (it uses an in-memory store when no store file
exists) and prints per-state counts (`legacy`, `mapped`, `actions`) and a per-ID diff with each
record's action: `insert`, `unchanged`, `changed`, `invalid` or `duplicate`. A real import records
the fenced caller on each `msg.imported` event, in transactions of 250 records, then sends one
guarded wake per recipient left with `sent` messages. Re-running is a no-op: an imported ID is
`unchanged`, and a legacy record changed since its import is reported `changed` and left as it
was.

## Cutover

`store cutover --dry-run` takes no caller and writes nothing (it uses an in-memory store when no
store file exists). It prints the fence it would write (`management`, `previousGeneration`,
`generation`), the import counts as `store import --dry-run` reports them, `importedUndelivered`
(imported messages that would be `sent`) and the recipients already holding undelivered
messages.

`store cutover --apply` requires the caller to be `game-coordinator` through the
[writer fence](#writer-fence) (`not-coordinator` otherwise) and refuses a pending work protocol
(`protocol-pending`). It then, in order:

1. creates `coordination.db` if needed;
2. writes the [cutover fence](#cutover-fence) under the exclusive protocol lease, which waits for
   legacy writers holding the shared lease, so every later legacy message write is refused;
3. imports the legacy message stores with their original IDs ([legacy import](#legacy-import));
4. records a `store.cutover` event with `cutoverAt`, the generations and the import counts; and
5. sends one guarded wake per recipient left with undelivered messages.

A repeated `--apply` after a completed cutover does nothing and reports `applied: true`. One
interrupted after the fence resumes from the import with the fence's `cutoverAt`.

### Runbook

Run it in one window after a scheduled review, from :35 to :55 America/Toronto, on a day with no
planned handoff.

Preconditions:

- The coordinator root still pins 1.3.x: delivery-kit 6.0 runners accept only `>=1.2.0 <2.0.0` and
  defer reviews and event flushes when the root CLI is outside that range, so 2.0 is pinned inside
  the window, never before it.
- delivery-kit 6.1 (`>=2.0.0 <3.0.0`) is tagged and ready to replace each runner.
- Every Claude role's channel MCP server runs the stable command
  `node <root>/node_modules/@andornaut/coordination-kit/dist/cli.js --root <root> claude channel`.
- Roles have finished in-flight sends and closes.

Steps, all in the window:

1. Pin 2.0 at the coordinator root (`npm ci`). From here 6.0 runners defer reviews and event
   flushes; their outbox is retained and departures continue.
2. Reconnect every Claude channel (`/mcp`) onto 2.0; `harness doctor` shows `channel_command`
   `stable` where the shared config is used and `channel_server` version `2.0.0` for channels that
   report their status.
3. Back up the state root, `var/work-protocol-fence.json` and `var/game-dev/messages`.
4. Run `store cutover --dry-run` and match its counts against the message inventory; for a per-ID
   diff, run `store import --from-legacy --dry-run`.
5. Run `store cutover --apply` as `game-coordinator` and record its `cutoverAt`.
6. Replace every runner with delivery-kit 6.1 while idle (all are idle after their own
   departures); each imports its unsent 6.0 outbox at start.
7. Check `review show` after the next scheduled review, and `msg history --since <cutoverAt>`.

Native prompts, registry held flags, route state and delivery controls are not touched. A
recipient whose question state is unknown gets no wake and pulls at its next boundary.

## Rollback

Messages are never sent natively, so rollback re-records what the store holds:

1. Ask the roles to stop sending and closing, then run `store export --since <cutoverAt>`. It
   lists every `msg.sent` recorded after it with its body, and every `msg.closed` and
   `msg.retained` with its actor, in seq order. Imports are excluded.
2. Restore `var/work-protocol-fence.json` from the backup, or write the cutover fence's
   `previous` back to it (delete the file when `previous` is `null`). This kit is then in legacy
   mode and a 1.3 CLI resolves the protocol selection again.
3. Before any 6.0 runner starts, ingest the remaining `events.jsonl` lines once with 2.0
   (`events ingest`), as delivery-kit's 6.1 to 6.0 rollback requires.
4. Restore the 1.3 pins at the coordinator root (`npm ci`), replace runners with 6.0 if they were
   moved to 6.1, and reconnect the channels. 1.3 has no
   store verbs and ignores `coordination.db`, which stays as the record.
5. Re-record each exported message with `message send` under its original ID and dispatch it
   through the legacy guarded path; recipients re-close the exported closes.

A later cutover records a new `store.cutover` event with its own time.
