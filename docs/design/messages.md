# Messages

Messages live in the coordination store: `msg send` commits the original before anything native
happens, and the recipient pulls it with `inbox`. A wake only asks the recipient to pull. One
adapter per harness delivers it to the role's current binding: a per-role wake file that the
Claude channel announces, so it follows a `/clear` rebind, or one guarded Codex control-socket
queue add. Registry state, role and policy holds and pending store questions guard each wake.
The scheduled review is the one rearm path: it wakes every recipient with unread originals
once per slot, past a pending question but not past a hold. Native or channel acceptance is
delivery, not handling; the recipient closes or retains each original.

Reference: [messages](../messages.md), [store wakes](../store.md#wakes),
[commands](../commands.md#command-semantics).

## Work items

| ID      | Title                                                                  | Link                                                                                       |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ck-0004 | Scale the message store                                                | [ck-0004.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0004.md) |
| ck-0005 | Retry a busy transport                                                 | [ck-0005.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0005.md) |
| ck-0009 | Fix the recipient status binding conflict                              | [ck-0009.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0009.md) |
| ck-0024 | Read exact messages and clarify retention                              | [ck-0024.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0024.md) |
| ck-0045 | One wake path that follows the role on both harnesses                  | [ck-0045.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0045.md) |
| ck-0051 | Resolve channels across project directories and report unresolved ones | [ck-0051.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0051.md) |
