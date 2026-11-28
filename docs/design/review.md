# Review

The [review route](../reference/review.md#review-route) names the host app and target roles.
When the host app's runner reaches a configured `wakeMinutes` slot, this kit composes the review and records
it for that app's `reports.recipient`. Each app's event messages go to its own `reports.recipient`. A
held route, or no route, delivers no scheduled review.

Review briefs and event messages live in the coordination store. The Claude channel watches a
wake file. Codex receives a guarded notice through the control socket. Recipients collect and
record handling of exact originals in the store. Unavailable native capabilities stay
explicitly unknown and are never reported as an empty queue or as clearance.

Reference: [review](../reference/review.md), [commands](../reference/commands.md#command-semantics).

## Work items

| ID      | Title                                                 | Link                                                                                       |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ck-0006 | Track Claude worker lineage                           | [ck-0006.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0006.md) |
| ck-0021 | Correct scheduled review decision and worker coverage | [ck-0021.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0021.md) |
| ck-0025 | Reserve review capacity for worker evidence           | [ck-0025.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0025.md) |
| ck-0026 | Consolidate routine departure notices                 | [ck-0026.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0026.md) |
| ck-0061 | Restore bounded native worker visibility in reviews   | [ck-0061.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0061.md) |
