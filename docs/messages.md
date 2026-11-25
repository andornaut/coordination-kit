# Common messages

Role messages in the coordination store (`msg` and `inbox`). The legacy `message` commands, the
Claude spool and the transport outbox were removed in 3.0; their records are in the Phase 4
archive ([retirement](store.md#retirement)).

## Store messages

Every send is stored before anything native happens, and recipients pull. The caller is
identified by the [registry fence](store.md#writer-fence); `--native-id` and `--worker` apply to
every writing verb.

```bash
coordination-kit msg send --to archies-dog-walks/tech --body-file note.md --link work=ck-0017
coordination-kit msg status 00000000-0000-4000-8000-000000000001 --include-body
coordination-kit inbox --peek
coordination-kit inbox --include-body
coordination-kit msg done 00000000-0000-4000-8000-000000000001 --work ck-0017
coordination-kit msg retain 00000000-0000-4000-8000-000000000002 --reason "waits on art" \
  --next-review
coordination-kit msg retain 00000000-0000-4000-8000-000000000003 --reason "check after integration" \
  --until 2026-11-22T18:30:00Z
```

- States are `sent`, `delivered` (the recipient's own `inbox` read), then `handled`, `superseded`
  or `retained`. The recipient alone closes an original.
- `msg send` stores the original, marks the recipient wake-pending and attempts at most one
  guarded wake, which carries no payload. Repeating the same original returns its recorded
  evidence without another native attempt. A wake outcome never changes message state.
- A recipient whose wake was guarded or failed keeps its originals in its inbox and in the
  scheduled review, which wakes it once per review while they stay unread
  ([store wakes](store.md#wakes)). `--intent unblock` marks urgency for the recipient; it
  creates no coordinator notice.
- Native session messages and channel notifications are wakes only; `msg send` is the one payload
  path between roles.
- Output is one JSON object, identical for Claude and Codex callers. `msg status ID` and
  `msg history` show metadata by default. `msg status ID --include-body` reads one exact original
  without recording delivery. The registry fence permits its sender, recipient and
  `game-coordinator` to see the body. `msg history --include-body` applies the same visibility
  rule to each body's events.
- `msg status ID` includes the latest explicitly associated wake outcome, reason code, blocker
  reference and next safe action. A coalesced original references the outstanding wake and has
  its own outcome. Evidence missing from older events stays unknown.
- `inbox --peek` shows the current role's unread originals and wake metadata without recording
  delivery, clearing a guard or sending native input. The scheduled review preserves the same
  metadata for its review slot. Use the store surfaces while a question or unknown state is
  guarded.
- `msg retain` takes exactly one boundary. Use `--until` with a timezone-qualified ISO instant,
  `--next-review` for the first scheduled review after retention, or `--next-boundary TEXT` to
  keep a dependency or hold description. Existing boundary text remains valid.

Schema, wakes and the writer fence are in [the coordination store](store.md).
