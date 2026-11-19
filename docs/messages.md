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
coordination-kit inbox --include-body
coordination-kit msg done 00000000-0000-4000-8000-000000000001 --work ck-0017
coordination-kit msg retain 00000000-0000-4000-8000-000000000002 --reason "waits on art" \
  --next-boundary "next scheduled review"
```

- States are `sent`, `delivered` (the recipient's own `inbox` read), then `handled`, `superseded`
  or `retained`. A message closes with one write, by its recipient only.
- `msg send` stores the original, marks the recipient wake-pending and attempts at most one
  guarded wake, which carries no payload. A wake outcome never changes message state.
- Native session messages and channel notifications are wakes only; `msg send` is the one payload
  path between roles.
- Output is one JSON object, identical for Claude and Codex callers. `msg status ID` and
  `msg history` read without writing and print no body. `msg history --include-body` identifies
  the caller through the registry fence and prints the bodies of messages it sent or received, or
  every body to `game-coordinator`; other messages stay metadata.

Schema, wakes and the writer fence are in [the coordination store](store.md).
