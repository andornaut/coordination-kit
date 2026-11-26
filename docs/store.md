# Coordination store

The coordination store behind the `msg`, `inbox`, `work`, `graph`, `question`, `hold`, `decision`,
`session` and `handoff` commands: its schema, the library API, the writer fence, wakes, questions, holds and decisions,
runner event ingest, work records, the decision graph, the approval-ledger import, imported
requests and the Phase 4 retirement. The design is in
[simplification](design/simplification.md#phase-2-one-store-and-one-message-path) and
[Phase 3](design/simplification.md#phase-3-work-decisions-questions-and-holds) and
[Phase 4](design/simplification.md#phase-4-thin-protocol-and-retirement).

## Location and settings

Before activation, the store is `coordination.db` in the state root named by
`var/work-protocol.json`, or `var/coordination.db` when that pointer is absent. The
[filesystem migration](upgrading.md#filesystem-authority-migration) selects one authority at
a time. Active file state belongs in the ignored `var/coordination/` of the explicit primary
coordinator checkout. The immutable batch journal and committed records are authoritative.
The query index is rebuilt from the journal in memory. Wake endpoints still use the existing
state root. Runner state, routing and registry files retain their existing paths.

Before activation the SQLite source opens through `node:sqlite` (`DatabaseSync`, built into Node 24.21 with no flag) with
`journal_mode=WAL`, `synchronous=FULL`, `busy_timeout=5000` and `foreign_keys=ON`. A new file is
created with mode 0600 in a 0700 directory. `PRAGMA user_version` holds the schema version, 1; a
newer version is refused with `store-schema-newer`. Every write is one `BEGIN IMMEDIATE`
transaction holding the event and its projection updates. No native call runs inside a
transaction.

## Filesystem layout

The following example shows an activated store with records for Archie. Sequence numbers and
record IDs are illustrative. Subdirectories appear as records are written.

```text
var/coordination/
├── qualification.json
├── source-fence.json
├── .migration.lock
├── journal/
│   ├── writer.lock
│   ├── batches/0000000000000001.json
│   └── keys/<event-key-sha256>.json
├── roles/
│   ├── archies-dog-walks%2Fart/
│   │   └── messages/originals/<message-id>.json
│   └── archies-dog-walks%2Ftech/
│       ├── messages/dispositions/<message-id>/42.json
│       ├── questions/<question-id>/43.json
│       ├── holds/<hold-id>/44.json
│       └── workers/<verified-worker-id>/work/archies-dog-walks/<work-id>/45.json
├── coordinator/
│   ├── holds/<policy-hold-id>/46.json
│   ├── handoffs/<handoff-id>/47.json
│   ├── delivery/48.json
│   └── reviews/49.json
└── legacy/quarantine/50.json
```

| Path                                                         | Meaning                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `qualification.json`, `source-fence.json`, `.migration.lock` | Migration proof, durable source-fence witness and migration lock. The authority receipt is the sibling `var/coordination-authority.json`.                                      |
| `journal/batches/<first-seq>.json`                           | Immutable commit manifest with the event range, hash chain and exact companion path digests. The filename is the first sequence padded to 16 decimal digits.                   |
| `journal/keys/`, `journal/writer.lock`                       | Per-event idempotency index and bounded journal writer lock. A pending transaction may leave prepare or staging files in `journal/` for recovery.                              |
| `roles/<encoded-role>/messages/`                             | Sender-owned originals and separate recipient-owned dispositions by exact message ID and event sequence. `%2F` encodes a slash in a game role key.                             |
| `roles/<encoded-role>/`                                      | Per-role inbox reads and wakes, sessions, work, requests, questions, decisions and holds. Verified worker work records can use a child namespace under the actual parent role. |
| `coordinator/`                                               | Policy holds, handoff records, runner ingest and scheduled review evidence.                                                                                                    |
| `legacy/quarantine/`                                         | Events or event parts whose ownership or scope could not be verified. They stay available as evidence with their reason.                                                       |

A companion path carries authority only when a committed batch names its exact digest. The next
writer recovers uncommitted preparation. Use the CLI to read and change coordination state.
Keep the journal, companion records and authority metadata out of Git, and retain independent
backups outside the checkout. See [configuration and Git boundaries](configuration.md#state).

## Compaction planning

The read-only filesystem plan counts up to 100 recent closed originals per recipient by
verified close sequence. Each recognized routine source stream has its own 100-event
window by committed sequence. Initial routine streams cover session starts per role and
scheduled ticks per game with no stage status, work list or commit SHA. The report keeps
other event kinds protected, including runner outcomes, wake and reminder evidence,
questions, decisions, approvals, holds and handoffs.

Only handled or superseded originals outside the window enter the replacement check.
Open or retained originals, unknown ownership or close order, unresolved delivery and
dependencies of open or unresolved messages stay protected. Aged originals require evidence that their
owner verified a durable replacement and reconciled live references. Aged routine events
require a verified checkpoint covering state, evidence, runner identity, cursors and keys.
Both proofs bind to the exact journal head and registry revision. Without proof the plan
reports aged items and their protection reasons. Dates and references remain in the
existing authoritative records.

Each stream counts originals or events once. `bodyBytes` measures raw message text in
UTF-8. `payloadBytes` includes its JSON encoding and other payload fields.
`journalBytes` is the canonical UTF-8 event size, including the event envelope.
`metadataBytes` is the difference between `journalBytes` and `payloadBytes`.
The report supplies `diskSavingsBytes: null`. Batch separators, companion copies,
filesystem allocation and future checkpoint data determine physical savings.

A qualified replay prefix binds its reduced entries to an independently verified
receipt. The query index checks each reduced entry against that receipt and checks
ordinary events against their original hashes. Rebuild repeats these checks.
The first tail event must extend the original checkpoint head by one sequence.
Projected closed messages keep their identity, links, dates and disposition.
An authorized body lookup or history entry reports `bodyExpired: true` when its
body was removed. A legacy empty string remains a present body. Export keeps
replayable sends in `messages` and puts expired send metadata in `expiredMessages`
when present. Close evidence stays in `closes`.

The current manifest commits event hashes and companion digests. Expiration needs a
separately qualified generation that preserves live projections, key and disposition
resolution, rollback evidence and the chain anchor while removing retired payloads from
active replay. Qualification rehearses concurrent writes, interruption, retry, rebuild
and independent restore. At an approved idle review boundary, recheck the exact head and
registry binding before selecting a prepared generation under the writer lock. Keep loose
copies and backups through the review. Pruning after that review requires a separate decision.

## Filesystem compaction runbook

Run these commands from the primary workspace checkout as an active `store:maintain` operator.
Use the existing scheduled review and operator approval lane.

1. Run `store compaction-plan` and record the exact head and registry revision. Confirm the
   decisions, approvals, open or retained messages and other material evidence that must remain
   accessible. Restore a separate full copy of the selected compactable filesystem authority
   from backup. Include its selector, checkpoint files, selected tail, permanently fenced
   predecessor journals, keys and committed companions. Use an absolute real path outside the
   checkout and current state, with independent regular files. Exclude every transient
   `compaction-reservation.json` from the restored copy. Preserve external runner cursors and
   receipts at their existing paths.
2. Use a JSON evidence file with schema 1, the plan's `head` and `registryRevision`,
   `messages`, and `routineEventSequences`. For each message give its exact `id`, `owner`,
   `closeSeq`, and `replacement`. The owner's terminal close must list that durable reference
   in its evidence. The owner verifies the replacement and reconciles live references before
   inclusion. List routine event sequence numbers only after verifying their place in the
   restored history and confirming the state, evidence, cursor and key coverage. Both arrays may
   be empty. A candidate needs at least one exact original that passes the plan's eligibility checks.
   Entries reported as `already-compacted` retain their original sequence, key, hash and proof.
   Leave them out of the new evidence.
3. Obtain custody at the existing idle review boundary. Confirm every writer is on a
   reservation-aware version or is parked, and drain operations that can still send, record
   receipts or advance cursors after the journal commit. Preserve independent questions and holds.
   Reserve with a new operator request UUID and the exact planned head and registry revision.
   The reservation waits for the existing writer lock before recording the tuple and an
   acquisition UUID (`nonce`) beside the selected journal. The first journal uses
   `var/coordination/compaction-reservation.json`. A selected checkpoint uses the marker at the
   root of its tail. The journal stays readable. Reservation-aware writes refuse with `compaction-reserved` before their
   journal transaction begins. Keep custody and preserve the registry revision and routing through
   activation or an exact retry. The reservation has no automatic expiration. An exact reserve
   retry returns the same acquisition while it is active.
4. Run prepare with the reservation request UUID, independent restore, evidence and a new absolute
   receipt path outside the checkout, current state and restored copy. It compares the source
   with the restore and writes only the receipt. The receipt ID identifies the exact prepared
   candidate, including its acquisition, evidence and restore. Keep the receipt, evidence and
   restore together through the review.
5. Obtain explicit activation approval for that receipt ID and preserve its evidence outside
   the reserved journal. Store-backed question and answer writes defer during the reservation.
   Invoke activate with the same restore, evidence and receipt, the receipt ID and the approval
   reference. The coordinator verifies approval and custody. The command rechecks the inputs,
   registry and reservation
   before permanently fencing the old journal. The selected journal accepts writes after
   activation. If interrupted after fencing, retain custody and retry the same activation.
6. To withdraw before fencing, use cancel with the original request UUID, acquisition UUID,
   head and revision. A registry change before fencing requires a new plan and acquisition.
   Cancelling allows writes to the original journal again and invalidates its reserved receipts.
   After fencing, use the exact activation retry. A partial receipt from interrupted prepare
   can remain at its exclusive path. Use a new path for requalification. Keep the restored backup
   and all loose copies until the operator separately authorizes cleanup.

Repeat the same procedure for the next generation. A repeat requires a reservation on the
selected tail. The successor checkpoint binds the predecessor's exact ID, head and digest.
Activation permanently fences that tail and selects the successor with a fresh tail. The restore
check verifies the committed manifests and companion hashes from each predecessor. Exact retry
uses the same receipt while its predecessor or that receipt remains selected. An older receipt
cannot move the selector back.

Keep the selected and predecessor checkpoint files, permanent fences, committed batch manifests,
per-event keys and every companion named by a manifest in both the live chain and independent
restore. Future repeat qualification reads these files. A separate cleanup review can assess
unreferenced loose copies. Preserve the committed chain even after that review.

Legacy unreserved prepare and activate remain available for the first checkpoint when no
reservation exists. The retained journals and restored copy contain the original bodies.
There is no scheduled activation or cleanup. Before a second activation, follow the
[repeat compaction compatibility requirements](upgrading.md#repeat-filesystem-compaction).

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
  times and open block ([work records](#work-records)). A record's finish status and successors
  are read from its `work.finished` event.
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
- `policy_holds`: one row per coordinator-issued user hold with issuer, exact scope and the
  approval references for set and release.
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
later projection can read it on its next rebuild. A journal may also hold `reminder.claimed`,
`reminder.settled`, `notice.consumed` and `notice.released` from the retired reminder ledger and
native notice proofs, and generated coordinator attention as ordinary messages. They replay
without error: a notice ends the exact outstanding wake it names, an attention message closed with
`attention-source-cleared` keeps no delivery time, and the reminder kinds project nothing.
Compaction still qualifies all of them. `store rebuild` drops the retired `pending_notices`,
`reminder_claims` and `reminder_originals` tables. A store written before a projection existed
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
4. The recipient records one disposition with `msg done ID` (`handled`, or `superseded` with
   `--superseded-by`), or `msg retain ID` with an owner, reason and next boundary. A retained
   message stays open and can be retained again or closed. A close or retention of a message
   still `sent` also sets its delivery time, since the recipient acted on it.

Both commands accept repeatable `--evidence REF` links. `msg status ID` exposes the evidence
alongside the disposition. A retention that omits evidence keeps the existing refs. A retention
with evidence replaces them with the supplied set.

Only the recipient can deliver, close or retain its own messages (`not-recipient`). Repeating a
send with the same ID and identical content, or the same close, is a no-op reported with
`duplicate: true`; any other reuse is `id-conflict` or `already-closed`. A send without `--id`
gets a fresh UUID, so a retry that must not duplicate passes `--id`.

### Unverified originals

The recipient can collect and retain an unverified original. For each such original, the store
tracks a separate decision tied to its message ID and body SHA-256. After collecting the exact
original, the bound recipient displays the user prompt and records its reference with
`msg decide ID --body-sha256 HASH --prompt REF`. The pending decision starts with display
`unknown` and records display as `attested` on that write.

After the user replies, the same recipient records
`msg decide ID --body-sha256 HASH --approve --scope TEXT --user-reply REF` or
`msg decide ID --body-sha256 HASH --decline --user-reply REF`. The reply reference is distinct
from the prompt reference. Approval applies only to the recorded scope for this original.
`msg done` requires approval for an unverified original. Decline closes it with the recorded
decision `declined`. Older readers see the existing terminal state `handled`, which here means
the original is closed without taking up the request. Check the decision in `msg status` or
the inbox when verifying what happened. Approval does not grant any registry permission.

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
writes, `question open|answer|project|cancel|close-legacy`, `hold set|release`, `request close`,
`store retire --apply`, `session start` and `handoff open|ready|state|active`) identifies its
caller before opening the store. `msg send` accepts `caller-unbound` and `caller-unidentified`
as a local unbound sender to a registered recipient. It stores `[unbound]` as the sender, keeps
no native ID or worker attribution, and uses queue intent even when `--intent unblock` was
supplied. The existing guarded wake and recipient lifecycle apply. Sender identity, work
authorization and every other command's registry requirements are independent of this queue
entry. `inbox --peek` identifies the recipient for its read-only view.
`msg decide` requires the recipient's own binding with no worker attribution.
`msg status` and `msg history` also identify the caller when
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
epochs, claims or enrollment. Every send reads `var/registry.json`; nothing is cached. The one
exception that writes a binding is `session start`, which may
[rebind a Claude role after /clear](#rebind-after-clear) before the fence admits the caller.

A worker writes under its parent's binding. `--worker NAME` records an attribution beside the
role on the event and the message. It is not verified: any caller bound to the role may name any
worker, so it is a label for reading history, not an identity.

Under file authority, an approved child work item with a linked parent can be started by
an exact Codex child whose lineage is verified in the latest applicable scheduled review.
That child may record its implementation evidence and mark the same item ready. The
CLI uses the actual child environment binding for this path. An explicit ID or a worker
label alone retains role attribution. Missing and stale lineage stay unverified.

Reads (`msg status` and `msg history` without `--include-body`, `question list`, `hold list`,
`decision list`, `store import --dry-run`,
`store retire --dry-run`, `work show`,
`work history`, `handoff show` and the `graph` commands) take no caller.
Legacy game mode also allows `store export` and `store rebuild` without a caller.

### App-mode permissions

In an [app workspace](configuration.md#workspace-configjson), privileged operations check
the caller's exact current native binding and active ownership. Held bindings cannot exercise
these grants. A workspace grant applies across the workspace. An app grant applies only to
checks for that app ID. A workspace-only check requires a workspace grant.

- `review deliver` and `events ingest` require `review:deliver` and `events:ingest`
  respectively for the selected app. Provision the active runner binding explicitly. The
  same checks apply with `--game`. Unattended legacy game runners retain their established
  route and operation checks.
- `delivery:operate` grants the app permission for manual delivery. Delivery still requires
  the existing verified operator check. The operation's `busOwner` is a registry reference.
- `messages:read-all` is the workspace grant for reading other roles' message bodies. A
  role's own inbox and dispositions retain the recipient checks above. `store export`
  requires the same workspace grant.
- Workspace-level administration uses `store:maintain` for store writes such as rebuild,
  ledger import, migration and compaction, `handoff:manage` for coordinating cross-role handoffs,
  and `registry:manage` for harness selection. A `policy:manage` grant can be scoped to
  an app for its policy holds. Workspace-wide policy operations require a workspace grant.

## Wakes

A wake carries no payload. Its only text is `N new messages for ROLE: run coordination-kit inbox`,
where `N` counts the recipient's `sent` messages. One adapter per harness delivers it to the
role's current binding:

- Claude: the store writes the role's [wake file](review.md#wake-files) through `writeWakeFile`,
  which advances `seq` by one. The file is keyed by role, so the channel serving the role
  announces it whichever conversation the role is bound to, including after a
  [rebind after /clear](#rebind-after-clear).
- Codex: one control-socket `thread/queue/add` through the guarded queue path, with a receipt at
  `wake/codex/<wake-id>.json` beside the store.

A wake is attempted only when the recipient is wake-pending, has `sent` messages and has no
outstanding wake for its current binding. Before claiming it, the store checks the registry: an
unregistered, unbound or held recipient (`ownership` not `active`, or `phase` `held` or
`source-held`) gets no wake. Then the store guard (`questionHoldGuard`, the default `storeGuard`
port of `wakeRecipient`) withholds it while the recipient has a pending question or an active
hold with scope `role`, logged `guarded` with `recipient-question-pending` or
`recipient-hold-active`. User policy holds for the exact role or its game withhold wakes with
`recipient-policy-hold-active`. Work-scoped holds and role-owned game holds apply at work start.
The guard is checked when claiming a wake and again before native delivery.

For Codex the queue path also checks, on one control connection, that the thread takes direct
input, waits on no question or approval (`state-unavailable` otherwise) and has a completed or
in-progress latest turn, and that no earlier wake for the role is still queued
(`native-notice-queue-unverified` when the queue cannot be read or holds one). A guard refusal is
logged as `guarded` and leaves nothing outstanding. An identical send returns the original's
recorded evidence without a native attempt.

Pulling the durable inbox clears the outstanding wake on either harness. An original arriving
behind an outstanding wake records `wake.coalesced` with its own ID and the prior wake reference.
A rebind leaves the earlier binding's outstanding wake unmatched, so the next send wakes the new
binding once.

The scheduled review is the one rearm path. After storing its brief, it clears the outstanding
wake of every recipient with unread originals and sends each one wake through its adapter. A
pending question withholds send-time wakes only: the review's wake pass skips the question check
and keeps the hold and policy hold checks, so a pending question delays a wake by at most one
review slot and cannot silence its role. A wake never answers or clears a prompt or hold. When the
owner answers or cancels its question or releases its hold, that command attempts one guarded
wake for it, which goes out only if no other guard remains.

Wake claims and refusals record the exact unread original IDs. `message_wakes` is an additive
projection rebuilt from those events. Older events without original IDs yield unknown evidence,
even when the recipient has other wake records. `msg status`, `inbox --peek` and the scheduled
brief expose reason codes and safe references without native payloads. Peek and review leave
delivery and handling to the recipient. Recorded reason codes from earlier wake guards, such as
`decision-marker-absent`, stay readable.

## Message history

`msg history` prints message events in seq order without bodies. With `--include-body` the caller
is resolved through the [writer fence](#writer-fence), and the `msg.sent` and `msg.imported`
events of messages it sent or received carry their `body`. The workspace `messages:read-all`
grant allows access to all bodies.
Other events stay metadata, and a caller the fence refuses gets no output.

## Questions, holds and decisions

Each record is owned by the role whose binding wrote it, and only that role can answer, cancel or
release it (`not-owner`); import and reviews never do. Ownership is by registry role on both
harnesses: after `harness select`, a `/clear` rebind or a move between harnesses, the role's
current binding acts on records an earlier binding wrote. Native prompts are never read or
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
  `already-closed`. Neither requires native evidence.
- `question close-legacy --id Q --reason R --approval REF` closes the caller's pending question
  opened under a Codex binding, citing the explicit user approval for the close as policy holds
  do. It appends `question.cancelled` with the reason and `approval`. A question opened on Claude
  is `legacy-question-required`; repeating the same close is a no-op. This verb is temporary and
  is removed once no pending question opened under a Codex binding remains.
- `--depends-on REPOSITORY:WORK_ID` on `question open` fences that exact work item at start, ready
  and finish on either harness. New `question.opened` events record the opener's `harness`.

Titles, reasons and options are single lines with no secret shape. Decision text also goes into a
public work file, so it is one line of at most 1000 characters with no secret shape,
home-directory path, UUID or this machine's host name (`text-not-public`); the host name is read
at run time and never stored.

### Codex question recovery

Before opening a Codex form in the owning conversation, use `question open` to record its exact
wording, ordered options and every dependent `--depends-on REPOSITORY:WORK_ID`. Repeated
`--option LABEL` takes ordered labels. Repeated `--option-json JSON` takes objects with a
`label` and optional `description`. `--work` separately names the decision Markdown target.
The durable record includes the thread that opened it.

- `question answer` records the user's explicit answer, and `question cancel` the owner's reason,
  with or without a recorded native identity. The caller supplies the public decision text
  explicitly, and the answer of a question with a Codex record is `--by user`.
- No command records a native identity. Replay keeps one that an existing store or journal holds
  on the question's `codex.native` and `codex.attempt` and on the pending-question wake blocker.

`question list`, session startup and reviews expose the recorded question independently of
native prompt visibility. Session startup includes the owning role's unread count. Messages
remain eligible for an explicit recipient inbox pull. Existing guarded native wakes still apply.
Only exact listed work dependencies are fenced at start, ready and finish under the store
transaction. Independent work retains its existing path.
The additional schema-1 question projections rebuild from the same event history.

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

### User policy holds

Game-coordinator uses `hold policy-set --id H --scope S --reason R --approval REF` to record an
explicit user instruction. Only its active registered conversation may issue or release these
holds. `REF` cites the explicit user instruction for the action. `H` is a distinct `policy-` ID.
Set appends `hold.policy-set` with the ID, issuer, scope, reason and approval reference.

| Scope                     | Work starts covered                 | Wakes covered        |
| ------------------------- | ----------------------------------- | -------------------- |
| `role:ROLE`               | Items owned by the registered role  | The registered role  |
| `game:GAME`               | Items in the configured game        | Its registered roles |
| `work:REPOSITORY:WORK_ID` | That exact repository and work item | None                 |

`hold policy-release --id H --approval REF` appends `hold.policy-released` for the exact policy
hold. Release keeps independent questions and holds intact. It attempts existing guarded wakes
for the affected registered roles. Matching retries are idempotent. Released IDs stay in history.

`hold list`, work show and status expose the exact target, issuer and approval references under
`policy`. The store appends these events and checks covering holds and work-start admission
under the same write lock. The derived policy projection is added when an existing schema-1
store is opened by a CLI that supports it.

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
counts of pending questions, active holds (including user policy holds for the role or game),
and open inbox messages (`sent`, `delivered` and `retained`), and each open handoff that
includes the role. A role whose phase is `held` or `source-held` is refused `session-held` with
the phase; an unbound caller gets the fence refusal unless the rebind below applies. Repeating it
appends another event.

### Rebind after /clear

A Claude `/clear` starts a new conversation ID, which the fence refuses as `caller-unbound`.
After `/clear`, a Claude role runs `session start` before any other store verb.
`session start` then rebinds the role, and only when every condition holds:

- No `--native-id` was given, and `CLAUDE_CODE_SESSION_ID` is a canonical UUID.
- Exactly one transcript `<projects>/*/<id>.jsonl` exists, where `<projects>` is
  `$CLAUDE_CONFIG_DIR/projects`, or `$HOME/.claude/projects` without that variable.
- The transcript header (records before the first `user` or `assistant` record, within 64 KiB)
  holds exactly one `derived-from` record whose `sessionId` is the caller and whose single
  `sessions` entry has `type` `claude_code_session`, `via` `clear` and a valid `id`. Fork and
  resume lineage do not count.
- That `id` is the effective Claude conversation of exactly one role whose effective harness is
  Claude. The role's phase is not `held` or `source-held` (`session-held`), and no open handoff
  includes it.

The rebind writes `roles.<role>.conversations.claude` under the registry revision `session start`
read; a changed revision refuses `rotation-conflict`. The session then starts with the new
binding, and its output adds `rotation` with the old ID (`from`) and the new registry `revision`.
Any other failed condition keeps `caller-unbound`. The registry revision and that output are the
record of the rebind; `session.started` keeps its existing payload. Codex callers and every other
verb are unchanged.

A handoff moves a scope of roles from their current harness to `--to`.
The coordinator in the table uses the workspace `handoff:manage` grant. In a legacy workspace
this is the configured `game-coordinator`.

| Command                    | Caller                    | From state                      | To state    | Requires                                  |
| -------------------------- | ------------------------- | ------------------------------- | ----------- | ----------------------------------------- |
| `handoff open --scope ...` | Coordinator               | none                            | `preparing` | No open handoff covering any role.        |
| `handoff ready`            | each role, source binding | `preparing`                     | unchanged   | Sets the hold `handoff-<id>-<role>`.      |
| `handoff state prepared`   | Coordinator               | `preparing`                     | `prepared`  | Every role ready (`handoff-not-ready`).   |
| `handoff state sent`       | Coordinator               | `prepared`                      | `sent`      |                                           |
| `handoff active`           | each role, target binding | `sent`                          | unchanged   | Releases the role's handoff hold.         |
| `handoff state completed`  | Coordinator               | `sent`                          | `completed` | Every role active (`handoff-not-active`). |
| `handoff state cancelled`  | Coordinator               | `preparing`, `prepared`, `sent` | `cancelled` | Releases every handoff hold still active. |

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
- Order to complete: after `sent`, a caller with `registry:manage` runs `harness select`
  for the scope, then each target session runs `session start` and `handoff active`, then the coordinator sets
  `completed`. The fence admits a target session only after select, which also fences out the
  source sessions (`caller-unbound`).
- `handoff show [--id ID]` prints the handoff, else the latest, with per-role ready and active
  times and its holds.

## Runner events

`events ingest` reads the selected app's runner log into the store. From the primary
workspace checkout, use the installed CLI as follows. Run delivery and ingest under the
[authorized binding](#app-mode-permissions).

```sh
node node_modules/@andornaut/coordination-kit/dist/cli.js review deliver \
  --app dashboard --slot 2026-11-26T17:30:00Z
node node_modules/@andornaut/coordination-kit/dist/cli.js review show --app dashboard
node node_modules/@andornaut/coordination-kit/dist/cli.js events ingest --app dashboard
```

`--game ID` is the backward-compatible selector for the same app and paths. Use one
selector per invocation. The schema-1 response echoes the ID as `appId` for `--app`, or as
`game` for `--game`. `review show` can omit the selector to look across apps and retains the
legacy `game` result field in that form. Other response fields and exit codes are unchanged.

The runner alone writes `var/apps/<id>/bus/events.jsonl`, or
`var/games/<id>/bus/events.jsonl` with the legacy state layout
(one JSON object per line, `\n`-terminated, one
`O_APPEND` write under 4096 bytes) and rotates it to `events.<epochSeconds>.jsonl` when the cursor
offset equals its size and the size exceeds 1 MiB. Ingest is the only reader:

```json
{
  "schema": 1,
  "id": "sha256(appId\ntype\nkey)",
  "appId": "dashboard",
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

- Schema 1 accepts `appId` or the legacy `game` member. Both can appear when both equal
  the selected app ID. The event ID remains the SHA-256 of the app ID, event type and key
  separated by newlines. Ingest normalizes both input forms to the existing stored payload.
  Existing event identities, cursor format and path identities remain compatible.
- `kind` is `attempt`, `gate`, `push`, `ci`, `deploy` or `runner`; `status` is `ok`, `failed`,
  `blocked`, `skipped`, `timeout` or `null` for a type with no outcome (such as `attempt` or
  `runner.started`); `type` is the exact legacy kind string, such as
  `ci_success` or `blocked-full-gate`. A line with the wrong event ID, an absent or different
  app identity, or invalid JSON in this
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
  "appId": "dashboard",
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
| `work finish ID`                                       | `work.finished`  | `status: done`, `superseded` or `cancelled` on `main` (`work-not-done`); see [finish](#finish). Once per item; it closes an open block.                       |

Stages are `implemented`, `merged`, `verified`, `published` and `deployed`; a SHA is 7 to 64
lower-case hex digits (upper case is folded). Reasons and references are one line of at most
2000 (references 512) characters and are refused when secret-shaped (`secret-shaped-text`).

`--parent` links a cross-role child request to its parent item in another repository, which must
be registered (`repository-unregistered`) and hold the parent's work file on its `main`
(`parent-missing`). The child stays owned by its own role.

### Finish

`work finish` records the work file's terminal status. A `superseded` item finishes only when a
work file on the repository's `main` names it in `supersedes` (one ID or a list);
`successor-missing` refuses it otherwise. The `work.finished` payload is
`{repository, id, owner}` for `done`, adds `status` for `cancelled`, and adds `status` and
`successors` (the superseding IDs in ID order) for `superseded`. A payload without `status` reads
as `done`. Compaction never reduces work events, so the extra fields replay and rebuild like the
rest of the payload. A finished record leaves the review's ready handoffs and the open items of
[`status`](commands.md#status), whatever its status.

A record's `state` is `finished`, else `blocked`, else `ready`, else `started`, else `recorded` (a
record made only by evidence or import). A finished record carries `finishedStatus` (`done`,
`superseded` or `cancelled`; null until finished) and `successors` (empty unless superseded).
`work show ID` prints the owner, the work file's status and title, the record (with its evidence,
retained items, parent and children) or null, and the holds covering the item. `work history ID`
prints the item's work events in order.

### Hold seam

`work start` and `work show` ask a `HoldLookup` port for the active holds covering the item. The
default, `storeHolds`, reads the [hold records](#holds): a `work:` hold that names the item, a
`role` hold whose owner is the item's owner, and a `game:` hold whose game is the item's
repository. It also covers items under an exact [user policy hold](#user-policy-holds).
`store import --approval-ledger` records each ledger hold as one `hold.imported`
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

Both commands return schema 2 JSON and read Git and the selected store on every invocation.
`unavailable` lists repositories whose work files could not be read.

## Approval-ledger import

`store import --approval-ledger FILE` maps each entry of the frozen approval ledger
(`schemaVersion: 1`, `entries` as a list or keyed object, `independentHolds`) to a work item.
`--dry-run` takes no caller and writes nothing (it reads the store when one exists, else uses an
in-memory one). A real import requires `store:maintain`, records everything in one transaction,
and repeats as a no-op.

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

- `Store.open(clock, path)`, `Store.forLayout({clock, env}, layout)`, `Store.readLayout({env},
layout)`, `storePath(layout)` and `storeRoot(layout)`. `clock` times the events a store appends;
  `env` is the environment for the Git checks of the file authority. A `readLayout` store refuses
  to time an event (`store-read-only`). The service contexts, such as `StoreServiceContext` and
  `IngestContext`, carry the same `clock` and `env`;
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
  `listQuestions`, `setHold`, `releaseHold`, `listHolds`, `listDecisions`
  (the `DecisionRow` records `graph` and `work check --decisions` read), `storeHolds` (the
  default `HoldLookup`), `questionHoldGuard`, `publicText(hostname, value)`, `holdScope` and
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
- `--apply` requires `store:maintain` through the [writer fence](#writer-fence).

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
