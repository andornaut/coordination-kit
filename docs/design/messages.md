# Messages

Messages live in the coordination store: `msg send` commits the original before anything native
happens, and the recipient pulls it with `inbox`. A wake only asks the recipient to pull. One
adapter per harness delivers it to the role's current binding: a per-role wake file that the
Claude channel announces, so it follows a `/clear` rebind, or one guarded Codex control-socket
queue add. Registry state and role and policy holds guard every wake. The scheduled review
can rearm unread originals once per recipient per slot. It skips the store question check
while preserving Codex native input checks and queue deduplication.

Native or channel acceptance records a wake result. The recipient's inbox pull records message
delivery. The recipient records handling or an explicit deferral with its next boundary and
available evidence. Exact status shows the first associated wake and the latest one.
The recipient collects an [explicit user decision](../reference/store.md#unverified-originals)
before recording handling of an unverified original.

Reference: [messages](../reference/messages.md), [store wakes](../reference/store.md#wakes),
[commands](../reference/commands.md#command-semantics).

## Work items

| ID      | Title                                                                  | Link                                                                                       |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ck-0004 | Scale the message store                                                | [ck-0004.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0004.md) |
| ck-0005 | Retry a busy transport                                                 | [ck-0005.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0005.md) |
| ck-0009 | Fix the recipient status binding conflict                              | [ck-0009.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0009.md) |
| ck-0024 | Read exact messages and clarify retention                              | [ck-0024.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0024.md) |
| ck-0045 | One wake path that follows the role on both harnesses                  | [ck-0045.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0045.md) |
| ck-0051 | Resolve channels across project directories and report unresolved ones | [ck-0051.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0051.md) |
| ck-0057 | Allow messages from unbound senders                                    | [ck-0057.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0057.md) |
| ck-0062 | Make guarded wake and owner disposition evidence actionable            | [ck-0062.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0062.md) |
| ck-0069 | Preserve a user decision for each unverified original                  | [ck-0069.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0069.md) |
