# Coordination store

The SQLite store behind the `msg`, `inbox`, `work`, `graph`, `question`, `hold`, `decision`,
`session` and `handoff` commands: its schema, the library API, the writer fence, wakes, questions, holds and decisions,
runner event ingest, work records, the decision graph, the approval-ledger import, imported
requests and the Phase 4 retirement. The design is in
[simplification](design/simplification.md#phase-2-one-store-and-one-message-path) and
[Phase 3](design/simplification.md#phase-3-work-decisions-questions-and-holds) and
[Phase 4](design/simplification.md#phase-4-thin-protocol-and-retirement).

## Location and settings

The store is one file, `coordination.db`, in the state root that `var/work-protocol.json` names
(`<stateRoot>/coordination.db`; see [state](configuration.md#state)). Without that file it is
`var/coordination.db` under the coordinator root. Every command uses the store: 3.0 has no legacy
mode, and the 2.0 cutover fence is no longer read. Wake files sit beside it
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
- `questions`: one row per question with its owning role, title, work ID, options, state
  (`pending`, `answered` or `cancelled`), opening and closing times, the answering decision and
  the cancellation reason. Indexed by `(role, state, opened_seq)`.
- `question_answers`: the exact answer, its recording sequence and its Markdown projection status.
- `decisions`: one row per decision, `{id, work, n, question, by, at, role, supersedes, text}`,
  unique per `(work, n)`, where `id` is `<work>/D<n>` and `supersedes` is `<work>/D<k>` or null.
- `requests`: one row per [imported request](#requests) with its owner, kind, summary, ledger
  state, question status, source, named work IDs, reason, required owner and close.
- `holds`: one row per hold with its owning role (null for an imported hold without one), scope,
  covered work items, source, ledger state, reason, state (`active` or `released`) and times.
  Indexed by `(role, state, set_seq)`.
- `sessions`: the latest `session.started` per role: harness, native ID, CLI version, cwd and time.
- `handoffs`: one row per handoff with its scope, from and to harness, state and opening and update
  times; `handoff_roles` holds each role's source harness and ready and active times.

Event kinds: `msg.sent`, `msg.imported`, `inbox.read`, `msg.closed`, `msg.retained`,
`wake.claimed`, `wake.completed`, `wake.guarded`, `wake.rearmed`, `bus.event`, `bus.complete`,
`review.brief`, `store.cutover`, `work.started`, `work.evidence`, `work.blocked`,
`work.unblocked`, `work.ready`, `work.finished`, `work.retained`, `question.opened`,
`question.answer-recorded`, `question.answered`, `question.projection`, `question.cancelled`,
`hold.set`, `hold.released`, `hold.imported`,
`request.imported`, `request.closed`, `store.retired`, `session.started`, `handoff.opened`,
`handoff.ready`, `handoff.state` and `handoff.active`. A kind with no projection is still stored and chained, so a
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

Every writing verb (`msg send`, `inbox`, `msg done`, `msg retain`, `store import`, the `work`
writes, `question open|answer|project|cancel`, `hold set|release`, `request close`,
`store retire --apply`, `session start` and `handoff open|ready|state|active`) identifies its
caller before opening the store. `msg status` and `msg history` also identify the caller when
passed `--include-body`. The caller is the registry role whose effective harness
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

Reads (`msg status` and `msg history` without `--include-body`, `question list`, `hold list`,
`decision list`, `store export`, `store rebuild`, `store import --dry-run`,
`store retire --dry-run`, `work show`,
`work history`, `handoff show` and `graph`) take no caller, and neither does `graph index`, which writes only the
derived index.

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
again. An accepted wake stays outstanding until the recipient's next pull, except that a review rearms
an accepted Claude wake still unpulled after 30 minutes, so a wake file written before a channel
restart is written again. An accepted Codex queue item persists in the recipient's queue and is
not repeated. A failed or ambiguous
wake is logged and stays outstanding: it is not retried before the recipient's next pull or the
next review, which may call `rearmWake`. A wake interrupted between its claim and its outcome
stays outstanding with no outcome, which reads as ambiguous.

After the registry checks, the store guard (`questionHoldGuard`, the default `storeGuard` port of
`wakeRecipient`) withholds the wake while the recipient has a pending question or an active hold
with scope `role`; it is logged `guarded` with `recipient-question-pending` or
`recipient-hold-active`. Work and game holds do not withhold wakes. For Codex the native question
check still runs after it. A wake carries no payload, so it never answers or clears a prompt or
hold. When the owner answers or cancels its question or releases its hold, that command attempts
one guarded wake for it, which goes out only if no other guard remains.

## Message history

`msg history` prints message events in seq order without bodies. With `--include-body` the caller
is resolved through the [writer fence](#writer-fence), and the `msg.sent` and `msg.imported`
events of messages it sent or received carry their `body`; `game-coordinator` sees every body.
Other events stay metadata, and a caller the fence refuses gets no output.

## Questions, holds and decisions

Each record is owned by the role whose binding wrote it, and only that role's binding can answer,
cancel or release it (`not-owner`); import and reviews never do. Native prompts are never read or
touched: a question record mirrors a prompt the owner has opened in its own session.

### Questions

- `question open --title TEXT` records a pending question owned by the caller. Without `--id` it
  gets the next role-scoped ID `q-<role>-<n>`, with `/` in a game role written as `-`
  (`q-archies-dog-walks-tech-3`), one above the highest such ID in the store. A retry that must
  not open a second question passes `--id`; repeating it with the same owner, title, work and
  options is a no-op (`duplicate: true`), and any other reuse is `id-conflict`.
- `question answer --id Q --work W --text T [--by user] [--supersedes Dk]` closes the caller's
  pending question and durably records the exact answer in a `question.answer-recorded` event before
  Markdown projection. A question opened with `--work` must be answered for that item
  (`work-mismatch`). `--by` defaults to `user`.
- `question project --id Q` retries the caller's stored answer without re-entering it. Repeating the
  same `question answer` also retries the writeback. Both use the active owner binding.
- `question cancel --id Q --reason R` cancels the caller's pending question. Answering or
  cancelling a closed question is a no-op when it repeats the recorded close, else
  `already-closed`.

Titles, reasons and options are single lines with no secret shape. Decision text also goes into a
public work file, so it is one line of at most 1000 characters with no secret shape,
home-directory path, UUID or this machine's host name (`text-not-public`); the host name is read
at run time and never stored.

### Decision lines

Projection reads `docs/work/<W>.md` in the main checkout of the caller's registered worktree's
repository. Once the file is readable, a `question.answered` event assigns a decision number one
above the highest in the store and the work file. An earlier unnumbered answer for the same work
item must be projected first (`decision-predecessor-pending`). A requested `--supersedes` must name
an existing number (`invalid-supersedes`).

```text
- D<n> (<by>, YYYY-MM-DD; answers <Q>[; supersedes D<k>]): <text>
```

The line uses the UTC date of the recorded answer. It is written atomically under `## Decisions`,
replacing a lone `None yet.` or inserting a missing line before the next higher number. The change
is left unstaged. Retrying verifies the exact line and restores a missing one, including after a
previously successful projection. A different line with the same number is preserved and reported
as `decision-line-conflict`.

The answer stays recorded when the worktree, main checkout, work file or Decisions section is
unavailable. In that case the command succeeds with `workFile.status: "failed"` and a reason. An
interruption before the first projection outcome leaves `question.answer.projection.status` at
`pending`. After a successful write or verification the status is `applied`. The numbered
`decision` is `null` until numbering succeeds. A legacy numbered decision can be checked or
repaired using the same command. Existing schema-1 stores acquire the answer projection when
opened by the updated CLI. Use that CLI for a rebuild after recording an answer receipt.

### Holds

`hold set --id H --scope work:W|role|game:G --reason R` records an active hold owned by the
caller; `role` scopes it to the owner itself. Repeating it with the same owner, scope and reason
while active is a no-op; any other reuse of the ID, including after release, is `id-conflict`.
`hold release --id H` releases the caller's own hold, including an imported
`approval-ledger:<id>` hold it owns; a repeated release is a no-op. Holds also gate `work start`
([hold seam](#hold-seam)).

### Lists

`question list [--role R] [--state pending|answered|cancelled]`, `hold list [--role R]
[--state active|released]` and `decision list [--work W] [--role R]` take no caller and print
`{schema, questions}`, `{schema, holds}` and `{schema, decisions}` in recording order. Tracked
answered questions expose the exact answer and its latest projection outcome. The decision list
contains numbered decisions. An absent store reads as empty.

## Sessions and handoffs

`session start` runs at a role's startup or resume. It resolves the caller through the fence,
appends `session.started` with the role, harness, native ID, CLI version and cwd, and prints the
role, harness and bound conversation, the registry revision, phase and ownership, the checkpoint
`var/handoffs/<scope>/current.md` (`games/<game>/<role>`, `kits/<kit>` or `game-coordinator`),
counts of pending questions, active holds (the role's own `role` holds and its game's `game:`
holds) and open inbox messages (`sent`, `delivered` and `retained`), and each open handoff that
includes the role. A role whose phase is `held` or `source-held` is refused `session-held` with
the phase; an unbound caller gets the fence refusal. Repeating it appends another event.

A handoff moves a scope of roles from their current harness to `--to`:

| Command                    | Caller                    | From state                      | To state    | Requires                                  |
| -------------------------- | ------------------------- | ------------------------------- | ----------- | ----------------------------------------- |
| `handoff open --scope ...` | game-coordinator          | none                            | `preparing` | No open handoff covering any role.        |
| `handoff ready`            | each role, source binding | `preparing`                     | unchanged   | Sets the hold `handoff-<id>-<role>`.      |
| `handoff state prepared`   | game-coordinator          | `preparing`                     | `prepared`  | Every role ready (`handoff-not-ready`).   |
| `handoff state sent`       | game-coordinator          | `prepared`                      | `sent`      |                                           |
| `handoff active`           | each role, target binding | `sent`                          | unchanged   | Releases the role's handoff hold.         |
| `handoff state completed`  | game-coordinator          | `sent`                          | `completed` | Every role active (`handoff-not-active`). |
| `handoff state cancelled`  | game-coordinator          | `preparing`, `prepared`, `sent` | `cancelled` | Releases every handoff hold still active. |

- `--scope all` takes every registered role not already on the target harness; a named role
  already on it is `already-on-target`. Without `--id` the ID is `h-<n>`. Repeating `open` with
  the same ID, scope and target, `ready`, `active` or the current state is a no-op; any other
  order is `invalid-transition`, `handoff-not-preparing` or `handoff-not-sent`.
- `handoff ready` and `handoff active` take the caller's open handoff, or `--id`; a role outside it
  is `not-in-handoff`. `ready` requires the caller's effective harness to be the role's source
  (`not-source`) and `active` the target (`not-target`).
- The handoff hold is a `role` hold owned by the role, so the [wake guard](#wakes) withholds wakes
  while the role sits ready and idle on its source harness. Once `harness select` binds the role on
  the handoff's target harness, the guard skips that hold, so the target session can be woken to
  run `handoff active`. The role's `handoff active` or the coordinator's `cancelled` releases it,
  then attempts one guarded wake.
- Order to complete: after `sent`, game-coordinator runs `harness select` for the scope, then each
  target session runs `session start` and `handoff active`, then game-coordinator sets
  `completed`. The fence admits a target session only after select, which also fences out the
  source sessions (`caller-unbound`).
- `handoff show [--id ID]` prints the handoff, else the latest, with per-role ready and active
  times and its holds.

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
- The initial `attempt` and its `attempt-captured` event share the attempt key. The capture
  carries the exact full `sha` for the verified gate snapshot or docs-only pinned push.
- Routine slot status, attempts, captures, progress and passing stage outcomes stay in the event
  history. A successful departure sends one COMPLETE. Failed, blocked and timed-out outcomes,
  runner startup and pin mismatch notices are sent separately from `delivery-kit` to
  `reports.recipient`, with message IDs derived from the event IDs.
- The events, their messages and any COMPLETE are one transaction. Then the recipient is woken,
  quarantined lines are appended, the cursor is written atomically, and only then are rotated
  files the cursor has passed deleted.

### COMPLETE

A commit's COMPLETE is derived once per (game, sha), as a `bus.complete` event with the key
`bus.complete:<game>:<sha>` and a message to `reports.recipient` whose ID derives from (game,
sha). It fires when, for that sha, a gate passed (`gate_passed` or another `ok` gate line, or
`skipped` for the docs-only `gate_skipped`), a push and CI are `ok`, and a deploy is `ok` or `skipped` (`deploy_disabled` for a
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

`events ingest` prints one line with the seam keys and the ingest counts, and the same exit
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

`work start` and `work show` ask a `HoldLookup` port for the active holds covering the item. The
default, `storeHolds`, reads the [hold records](#holds): a `work:` hold that names the item, a
`role` hold whose owner is the item's owner, and a `game:` hold whose game is the item's
repository. `store import --approval-ledger` records each ledger hold as one `hold.imported`
event, which the hold projection applies:

```json
{
  "id": "approval-ledger:<ledger hold ID>",
  "owner": "ROLE or null",
  "reason": "TEXT",
  "state": "the ledger's hold state, such as preserved or released, or null",
  "work": [{ "repository": "R", "id": "W" }],
  "entries": ["<ledger entry ID>"],
  "source": "approval-ledger"
}
```

The event key is `hold.imported:approval-ledger:<first 32 hex of sha256(ledger hold ID)>`. An owner
of null means the ledger names no registered owner: no caller can release the hold through the
fence, so game-coordinator surfaces it to the user.

An imported hold keeps its recorded owner and the work items it names, and its scope reads
`work:<repository>:<id>[,...]`. A ledger state that is null or open projects as `active`; a closed
one (`answered`, `cancelled`, `cleared`, `closed`, `released` or `superseded`) projects as
`released` with no release time, as history. Import never releases a hold; only its owner's
`hold release` does.

## Decision graph

Nodes are work items (`work:<repository>:<id>`), decisions (`decision:<repository>:<id>/D<n>`),
questions (`question:<id>`), roles (`role:<name>`) and commits (`commit:<sha>`). Edges:

| Edge         | From and to                        | Source                                                                       |
| ------------ | ---------------------------------- | ---------------------------------------------------------------------------- |
| `decides`    | decision to work                   | A [decision line](work-files.md#decision-lines), or a store decision record. |
| `answers`    | decision to question               | The line's `answers`, or the record's `question`.                            |
| `owned-by`   | work, or question, to role         | The item's [owner](#work-records); a store work or question record.          |
| `supersedes` | decision to decision, work to work | The line's or record's `supersedes`; front matter `supersedes`.              |
| `related`    | work to work                       | Front matter `related`.                                                      |
| `implements` | commit to work, with the stage     | `work evidence`.                                                             |
| `parent`     | child work to parent work          | `work start --parent`.                                                       |

Git is the durable copy: the work files on each registered repository's `main` (one `git log` per
repository). The store adds work records, the decision records through `listDecisions` and the
questions through `listQuestions` ([questions, holds and decisions](#questions-holds-and-decisions));
a work-file line wins over a store record of the same decision. A bare work ID resolves within its own repository first, else to the
one repository that holds it.

- `graph [--work [REPOSITORY:]ID] [--depth N] [--format json|dot]` prints every node and edge, or
  the nodes within `--depth` edges (default 2, either direction) of one item, as JSON or Graphviz
  DOT. `work-unknown` and `work-ambiguous` refuse an ID.
- `graph why --decision [REPOSITORY:]WORK_ID/Dn` prints the decision, the older decisions it
  supersedes and the newer ones that supersede it (nearest first), each with its work item's
  approval reference, and `current`, the newest of the chain.
- `graph index` rebuilds the derived `edges`, `graph_nodes` and `graph_index` tables in one
  transaction. Queries read them when present (`index.status` `stored`, with its time) and build
  live otherwise (`live`). They are not projections: `store rebuild` leaves them, deleting them
  loses nothing, and no event records them. `unavailable` lists repositories that could not be
  read.

## Approval-ledger import

`store import --approval-ledger FILE` maps each entry of the frozen approval ledger
(`schemaVersion: 1`, `entries` as a list or keyed object, `independentHolds`) to a work item.
`--dry-run` takes no caller and writes nothing (it reads the store when one exists, else uses an
in-memory one); a real import requires the caller to be `game-coordinator` (`not-coordinator`),
records everything in one transaction, and repeats as a no-op.

| Ledger                                                     | Imported as                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry                                                      | The work item in the repository of its `owner` (a role name, or an object with a `role`) whose ID is the entry's `work` (or `workId`), its ID or its leading work ID (`mapped-id`), else whose title equals its `title` or `behavior`, ignoring case and a trailing full stop (`mapped-title`). |
| `implementationSha`, `mainSha`, `deployedSha`              | `work evidence` at `implemented`, `merged` and `deployed`, with the reference `approval-ledger:<entry>`.                                                                                                                                                                                        |
| `stage` `verified`, `published`, `deployed` with `mainSha` | `verified` (and, for `published`, `published`) at `mainSha`, once per `interactionProof` item: the item as one line, or `approval-ledger:<entry>/interactionProof/<n>` when longer than 512 characters or secret-shaped.                                                                        |
| `unresolved` item                                          | A `work.retained` item: its text (or `gap`, `description`, ...), its owner (`owner` or `requiredOwner` when registered, else the entry owner) and next boundary (`nextBoundary`, `next` or `nextAction`, else `next scheduled review`).                                                         |
| `independentHolds`                                         | One [`hold.imported`](#hold-seam) per hold, top level or inline in an entry, owned by its recorded owner, with its ledger `state` and its `behavior` or `reason` as the reason, covering the work items of the entries that name it. Never released by import.                                  |

Outcomes per entry: `mapped-id`, `mapped-title`, `no-work-file`, `ambiguous` (several titles),
`owner-unregistered`, `repository-unavailable` and `invalid`; they sum to `entries`. Import never
creates a work file: `stubs` lists the unmapped entries per owner and repository for the owners to
stub, and their evidence and retained items are counted under `skipped`. The output also counts
inserted and unchanged events per type (`events`), SHA fields that are not object names
(`skipped.invalidSha`), and holds in total, closed, without a registered owner and covering no item.

## Library API

`@andornaut/coordination-kit/build/store` exports:

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
- Requests and retirement: `importRequest`, `closeRequest`, `readRequests`, `REQUESTS_PROJECTION`,
  `storeRetire`, `readLedgerRequests`, `RETIRED_PATHS`, `READ_WITH` and `COORDINATOR_ROLE`.
- Runner events: `ingestEvents(context, game)`, `parseBusLine`, `busEventId`, `readCursor`,
  `LOG_FILE`, `CURSOR_FILE`, `QUARANTINE_FILE`, `EVENT_KINDS` and `EVENT_STATUSES`.
- Notices from the runner's role: `DELIVERY_KIT_ROLE`, `DELIVERY_KIT_ACTOR`, `derivedId`,
  `reportsRecipient` and `storeNotice`.
- Projections: `DELIVERY_PROJECTION`, `QUESTIONS_PROJECTION` and `WORK_PROJECTION` beside
  `MESSAGES_PROJECTION`.
- Questions, holds and decisions: `openQuestion`, `answerQuestion`, `cancelQuestion`,
  `requireOwnQuestion`, `listQuestions`, `setHold`, `releaseHold`, `listHolds`, `listDecisions`
  (the `DecisionRow` records `graph` and `work check --decisions` read), `storeHolds` (the
  default `HoldLookup`), `questionHoldGuard`, `publicText`, `holdScope` and
  `normalizeOptions`; the work-file half `mainWorkFile`, `fileDecisionNumbers`, `decisionLine` and
  `appendDecisionLine`. Writers trust their `Actor` and refuse another owner's record.
- Sessions and handoffs: `HANDOFFS_PROJECTION`, `recordSession`, `openHandoff`, `readyHandoff`,
  `activeHandoff`, `setHandoffState`, `readHandoff`, `latestHandoff`, `openHandoffsFor`,
  `handoffHolds`, `handoffHoldId`, `HANDOFF_STATES`, `OPEN_HANDOFF_STATES` and
  `HANDOFF_TRANSITIONS`; the CLI services `storeSessionStart`, `storeHandoffOpen`,
  `storeHandoffReady`, `storeHandoffState`, `storeHandoffActive`, `storeHandoffShow` and
  `checkpointPath`.
- Work records: `startWork`, `recordEvidence`, `blockWork`, `unblockWork`, `readyWork`,
  `finishWork`, `retainWorkItem`, `readWorkRecord`, `readWorkRecords`, `workHistory`, `WORK_STAGES`,
  `WORK_KINDS`, the `HoldLookup` seam with `HoldCover`, and `importedHolds`, which reads the imported events
  alone. They trust their `Actor`;
  the owner check is the CLI's.
- The CLI services `storeSend`, `storeInbox`, `storeDone`, `storeRetain`, `storeStatus`,
  `storeHistory`, `storeExport`, `storeRebuild`, `storeQuestionOpen`,
  `storeQuestionAnswer`, `storeQuestionCancel`, `storeQuestionList`, `storeHoldSet`,
  `storeHoldRelease`, `storeHoldList` and `storeDecisionList`, and `StoreError` with its `code`.

The stored review brief (`storeReview`, `showBrief`, `composeBrief`) and the coordination event
port (`coordinationEmit`) are in `@andornaut/coordination-kit/build/review`.

## Requests

`store retire --apply` imports each request of the retired request ledger that is not closed
(`completed`, `cancelled` or `superseded`) as one `request.imported` event with the key
`request.imported:<id>`:

```json
{
  "id": "R",
  "owner": "ROLE",
  "kind": "request",
  "summary": "TEXT",
  "state": "open",
  "question": "pending",
  "source": { "origin": "owner-attested", "reference": "TEXT" },
  "work": ["ck-0017"],
  "reason": "TEXT or null",
  "requiredOwner": "ROLE or null",
  "updatedAt": "ISO"
}
```

`owner` is the ledger assignment's role, else the request's creator. `work` lists the request's
own ID and its target IDs that have the work-ID shape (`<prefix>-<4 digits>`). `status` lists an
open imported request as a `requested` item of its owner's repository until a work file names it
or its owner closes it, and as one of the `requests` of each work item it names.

`request close --id R --reason TEXT [--work W]` records `request.closed`; only the owner's
binding can (`not-owner`). `--work` names the work item that now carries the request, which then
lists it with state `closed`. The same close again is a no-op (`duplicate: true`); another
reason or work is `already-closed`. Reasons are one line of at most 1000 characters with no
secret shape.

## Retirement

`store retire` is the one-time 3.0 migration of the retired protocol state. Exactly one of
`--dry-run` and `--apply` is required.

- `--dry-run` takes no caller and writes nothing; it reads an existing store read-only.
- `--apply` requires the caller to be `game-coordinator` through the
  [writer fence](#writer-fence) (`not-coordinator`).

It reads the frozen request ledger from `<stateRoot>/accounting/checkpoint.json`, which must be
intact and cover every journal event (`ledger-checkpoint-stale`), and counts the pending intake
offers under `accounting/intake/`, which are dropped. An apply then:

1. archives `roles/`, `accounting/`, `transport/`, `locks/`, `migration/`, `migration-plan.json`
   and the coordinator's `var/work-protocol-fence.json`, whichever exist, as one tar.gz written by
   the system `tar` to `<stateRoot>/archive/phase4-<UTC date>.tar.gz` (state-root members by
   their relative path, the fence as `var/work-protocol-fence.json`);
2. writes the manifest beside it, `phase4-<UTC date>.json`: `{schema, kind: "phase4-archive",
archive: {name, sha256, bytes}, paths: [{path, files, bytes}], readWith, stateRoot,
createdAt}`, where `readWith` names the coordination-kit 2.1.2 release to read it with;
3. records every `request.imported` event and one `store.retired` event (key
   `store.retired:phase4`, whose payload is the printed result) in one transaction.

It never deletes or changes an original; deleting them needs separate user approval. A repeated
`--apply`, or a dry run after it, prints the recorded result with `duplicate: true` and writes
nothing. Output, one JSON object:

```text
schema        1
kind          store-retire
dryRun        true | false
applied       true once store.retired is recorded
duplicate     true when an earlier apply recorded it
stateRoot     the resolved state root
paths         [{path, present, files, bytes}]
requests      {ledger, closed, imported, alreadyImported, unowned: [ID], byState: {STATE: N}}
intakeOffers  {dropped}
archive       {path, manifest, sha256, bytes}   (sha256 and bytes null on a dry run)
```

`unowned` lists imported requests whose owner is not a registered role, which no binding can
close. The runbook and rollback are in [upgrading](upgrading.md#from-21).
