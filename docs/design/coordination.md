# Coordination

The kit owns the role registry, the coordination store and its messages, wakes and work
records, the harness adapters, the scheduled review brief and the work-file checks. delivery-kit owns the
resident runner, departures, the gate container, CI watches, deployment, scheduled delivery,
resource sampling, the pin guard, status and source and gate identity.

The dependency runs one way: delivery-kit imports this kit and this kit never imports
delivery-kit. The runner decides when a scheduled review slot is due and calls
`deliverScheduledReview`; the brief composition, inventory and delivery happen here. Events are
produced by the runner through `recordEvent`, with its own commit tracking under the outbox lock,
and delivered here by `flushEvents`. The utilities both kits need (durable files, locks, the
layout, validation, `delivery-kit.json` loading and the command contract) are exported once from
`build/shared`, and the API bundles share module instances so locks and error classes are the
same across subpaths. Every on-disk format stays byte-compatible with delivery-kit 4.7.0.

`work check` and `work report` apply the work-file convention to any repository's docs and join
its milestones with live protocol state. `status` reads every registered repository through local
Git refs only and derives one status per item from front matter, protocol and ledger state, the
landing commit on `main`, and the runner COMPLETE event, last deployed SHA or release tag that
contains it.

Reference: [review](../review.md#scheduled-review-seam), [libraries](../libraries.md),
[work files](../work-files.md), [status](../commands.md#status), [upgrading](../upgrading.md).

## Work items

| ID      | Title                                                   | Link                                                                                       |
| ------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ck-0001 | Extract the coordination kit from delivery-kit          | [ck-0001.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0001.md) |
| ck-0010 | Validate only the configuration sections this kit reads | [ck-0010.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0010.md) |
