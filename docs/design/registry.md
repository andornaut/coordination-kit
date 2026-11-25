# Registry

`var/registry.json` records each role's ownership, worktree and conversation ID per harness.
Every writer holds `registry.lock`, rejects a changed revision and writes durably. Each send
resolves the recipient's effective harness from its role override or the registry default, then
that harness's conversation ID, and caches nothing. A missing ID is `unavailable`, never
clearance. Harness selection changes only the explicitly selected roles' overrides; readiness
probes and the harness doctor send nothing and activate nothing.

A Claude `/clear` gives the session a new conversation ID. `session start` rebinds the role
when the caller's transcript header proves a `clear` derivation from exactly one role's current
effective Claude binding, the role is neither held nor in an open handoff, and the registry
revision is unchanged since the read. It replaces only that role's `conversations.claude`. Every
other case keeps the existing fence refusals, and Codex is unchanged.

Reference: [registry](../registry.md).

## Work items

| ID      | Title                                              | Link                                                                                       |
| ------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ck-0043 | Rebind a Claude role after /clear in session start | [ck-0043.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0043.md) |
