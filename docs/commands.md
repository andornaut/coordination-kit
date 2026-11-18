# Commands

Per-command semantics for the `coordination-kit` CLI, beyond the group table in the
[README](../README.md#usage), and worker inbox reconciliation. `coordination-kit --help` lists
every form and flag.

## Command forms

| Command                                                                                                                                                  | Purpose                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `inbox snapshot --game ID [--recipient ROLE] [--parent ROLE]... [--history-cursor CURSOR]`                                                               | Capture the recipient's inbox snapshot.                                                       |
| `inbox ack --game ID --snapshot UUID --queue-id ID... --disposition handled\|superseded\|retained [--reason TEXT] [--recipient ROLE] [--parent ROLE]...` | Acknowledge queue items from that snapshot. `retained` requires a reason.                     |
| `message send`, `dispatch`, `status`, `reconcile`, `retire-spool`                                                                                        | Durable role messages; see [messages](messages.md).                                           |
| `ledger intake`, `apply`, `show`, `report`, `history`, `coverage`, `reconcile`, `boundary`                                                               | The request ledger; see [request accounting](request-accounting.md).                          |
| `claude ready [--game ID]... [--role ROLE]...`, `codex ready [--game ID]... [--role ROLE]...`                                                            | The handoff readiness probe, optionally scoped; see [readiness](registry.md#readiness-probe). |
| `harness ready [--game ID]... [--role ROLE]...`                                                                                                          | Read-only readiness using each selected role's effective harness.                             |
| `harness select --harness claude\|codex\|default --expected-revision N [--game ID]... [--role ROLE]...`                                                  | Atomic selection for at least one explicit game or role, without activation.                  |
| `harness doctor --game ID ... [--role ROLE ...]`, `harness doctor --role ROLE ...`                                                                       | Diagnose explicitly selected roles without sending or activating.                             |
| `claude channel [--game ID]... [--conversation UUID] [--state-dir DIR]... [--poll-seconds N]`                                                            | The stdio MCP server the Claude recipient session starts.                                     |
| `protocol ...`                                                                                                                                           | The explicit filesystem work protocol; see [work protocol](work-protocol.md).                 |
| `work check [--root DIR]`, `work report [--root DIR]`                                                                                                    | Validate a repository's work files and report their state; see [work files](work-files.md).   |
| `help`, `--help`, `--version`                                                                                                                            | Usage and version.                                                                            |

## Command semantics

- `claude channel`: by default it serves the conversation of the `reports.recipient` that every
  game (or each `--game`) names, draining those games' spools and that conversation's message
  spool, and requires that role's effective harness to be `claude`. Games that name different
  recipients stop it with exit 1; select games with one recipient or pass `--conversation`. `--conversation UUID` and repeated absolute
  `--state-dir STATE/unblock` paths select the conversation and spools explicitly; `--state-dir`
  excludes `--game`. `--poll-seconds` defaults to 5. It creates no state directory and drains only
  spools that already exist, so it can start before any game state. Without `--conversation`, an
  absent registry stops it with exit 1. The server identifies itself to the session as
  `delivery-kit-channel`, the name existing channel configurations use.
- `message retire-spool --recipient ROLE_OR_UUID [--dry-run]`: moves unclaimed Claude spool
  entries whose parent message is `handled` or `superseded` from
  `<stateRoot>/transport/messages/recipients/<uuid>/unblock/claude-spool/` to the sibling
  `claude-retired/`, under `unblock.lock`. Without an active work protocol the same layout sits
  beneath `<reviewDir>/messages/`. Anything it cannot prove terminal and exactly bound is retained
  with a reason; see [Common messages](messages.md).
- `inbox snapshot` and `inbox ack`: `--recipient` defaults to the game's `reports.recipient`.
  `--recipient` and `--parent` take a role name, or a canonical conversation UUID registered for
  the active harness, with the worker recipient exception below. With Claude the recipient must
  be the active route's recipient, whose parents may be any route member, or a registered route
  target whose selected harness is Claude. A route target's snapshot and ACK cover only its own
  delivered entries and retentions, with no peer or target rows, and its snapshot accepts no other
  conversation as a parent. Any other Claude recipient is refused. With Codex every parent must
  belong to the active route. `--history-cursor` applies to Codex. An unreadable Claude channel
  spool is reported under the snapshot's `errors`, with `complete` false and exit 1; only a
  missing spool counts as empty. Both keep their JSON result on stdout and also name an error on
  stderr.
- `protocol enroll-self --role ROLE --at ISO_TIMESTAMP [--native-id ID]`: enrolls the caller's
  own registered role from its journal, registry binding and canonical references, refusing any
  other role. The native ID defaults to `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`; see
  [declaration, enrollment and rollout](work-protocol.md#declaration-enrollment-and-rollout).
- `work check` and `work report`: `--root` names the repository, not the coordinator. See
  [work files](work-files.md).

## Worker inbox reconciliation

Use the existing inbox commands with a canonical worker UUID and exactly one registered parent
role whose current Codex conversation belongs to the active review route:

```bash
coordination-kit inbox snapshot --game GAME_ID \
  --recipient WORKER_UUID --parent REGISTERED_ROLE
coordination-kit inbox ack --game GAME_ID \
  --recipient WORKER_UUID --parent REGISTERED_ROLE \
  --snapshot SNAPSHOT_UUID --queue-id QUEUE_ID --disposition handled
```

Snapshot capture verifies fresh native Codex lineage against that exact parent and persists the
worker/parent binding. ACK requires the same binding and uses one connection to verify lineage on
open, inspect the current queue and recheck lineage immediately before deletion. Wrong parents,
reparenting or refused reads fail closed and preserve originals. Unchanged-payload and ambiguous
acknowledgement guards remain in force. Use `handled` or `superseded` only with evidence; use
`--disposition retained --reason TEXT` for retained work. This is explicit owner reconciliation,
not automatic worker deletion; it never forces session loads or mutates native question state.
Unavailable visibility remains unknown and must be reported, without bypassing refusals.
