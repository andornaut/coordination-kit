# Review

`var/route.json` names the scheduled review's host game and its target roles. When the host
game's runner reaches a `config.json` `wakeMinutes` slot, this kit composes the review and sends
it to that game's `reports.recipient`. Each game's events go to its own `reports.recipient`. A
held route, or no route, delivers no scheduled review.

The Claude adapter spools briefs and events for `claude channel` while the recipient session is
listed as interactive. The Codex adapter steers turns through the control socket. Inbox snapshots
and acknowledgements reconcile exact unchanged originals. Unavailable native capabilities stay
explicitly unknown and are never reported as an empty queue or as clearance.

Reference: [review](../review.md), [commands](../commands.md#command-semantics).

## Work items

| ID      | Title                       | Link                             |
| ------- | --------------------------- | -------------------------------- |
| ck-0006 | Track Claude worker lineage | [ck-0006.md](../work/ck-0006.md) |
