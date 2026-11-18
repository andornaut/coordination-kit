# Messages

`message send` stores a common message locally and never dispatches it. `message dispatch` is an
explicit guarded delivery request: it checks ownership, routing and recipient decision guards
before any native send. Each attempt writes a bound receipt first. A failure proven to occur
before native admission permits a guarded retry; any other uncertain outcome is ambiguous and
is reconciled before a retry. Native or channel acceptance is delivery, not handling.

The Claude transport is a per-recipient spool under `unblock.lock`, drained by the
`claude channel` consumer, which rechecks each entry before claiming it. Status reports an
allowlisted diagnostic for each blocked or guarded result. Reconciliation records `accepted`,
`handled`, `superseded` or `retained` against exact evidence at the observed revision.

Reference: [messages](../messages.md), [commands](../commands.md#command-semantics).

## Work items

| ID      | Title                                     | Link                             |
| ------- | ----------------------------------------- | -------------------------------- |
| ck-0004 | Scale the message store                   | [ck-0004.md](../work/ck-0004.md) |
| ck-0005 | Retry a busy transport                    | [ck-0005.md](../work/ck-0005.md) |
| ck-0009 | Fix the recipient status binding conflict | [ck-0009.md](../work/ck-0009.md) |
