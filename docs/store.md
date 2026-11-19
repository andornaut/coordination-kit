# Coordination store

The SQLite store behind the `msg` and `inbox` commands: its schema, the library API, the writer
fence, wakes, the legacy import mapping and rollback. The design is in
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

Event kinds: `msg.sent`, `msg.imported`, `inbox.read`, `msg.closed`, `msg.retained`,
`wake.claimed`, `wake.completed`, `wake.guarded` and `wake.rearmed`. A kind with no projection is
still stored and chained, so a later projection can read it on its next rebuild.

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

Every writing verb (`msg send`, `inbox`, `msg done`, `msg retain`, `store import`) resolves its
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

Reads (`msg status`, `msg history`, `store export`, `store rebuild` and `store import --dry-run`)
take no caller.

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

The store's own question and hold records arrive in Phase 3. Until then the `storeGuard` port of
`wakeRecipient` passes every recipient; Phase 3 supplies one that blocks on an open question or
hold record.

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
- The CLI services `storeSend`, `storeInbox`, `storeDone`, `storeRetain`, `storeStatus`,
  `storeHistory`, `storeImport`, `storeExport` and `storeRebuild`, and `StoreError` with its
  `code`.

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

## Rollback

Messages are never sent natively, so rollback re-records what the store holds:

1. Ask the roles to stop sending and closing, then run `store export --since ISO` with the cutover
   time. It lists every `msg.sent` recorded after it with its body, and every `msg.closed` and
   `msg.retained` with its actor, in seq order. Imports are excluded.
2. Restore the backup and the previous pins. The previous CLI has no store verbs, so store writes
   stop there.
3. Re-record each exported message with `message send` under its original ID and dispatch it
   through the legacy guarded path; recipients re-close the exported closes.
