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

| ID      | Title                                                      | Link                                                                                       |
| ------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ck-0001 | Extract the coordination kit from delivery-kit             | [ck-0001.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0001.md) |
| ck-0010 | Validate only the configuration sections this kit reads    | [ck-0010.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0010.md) |
| ck-0028 | Document workspace layout and coordinator setup            | [ck-0028.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0028.md) |
| ck-0029 | Recover Codex questions and surface guarded messages       | [ck-0029.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0029.md) |
| ck-0030 | Apply the container memory ceiling to kit launchers        | [ck-0030.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0030.md) |
| ck-0031 | Escalate blocked inbox delivery to the coordinator         | [ck-0031.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0031.md) |
| ck-0032 | Simplify the command and operator workflows                | [ck-0032.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0032.md) |
| ck-0033 | Keep one outstanding notice per active recipient           | [ck-0033.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0033.md) |
| ck-0034 | Accept the legacy reports project field as optional        | [ck-0034.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0034.md) |
| ck-0035 | Plan and qualify filesystem history compaction             | [ck-0035.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0035.md) |
| ck-0036 | Release collected accepted notices beyond native history   | [ck-0036.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0036.md) |
| ck-0037 | Recognize complete replies to multi-question Codex prompts | [ck-0037.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0037.md) |
| ck-0038 | Diagnose owner clearance failures for idle recipients      | [ck-0038.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0038.md) |
| ck-0039 | Hold the journal head for manual compaction approval       | [ck-0039.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0039.md) |
| ck-0040 | Open the current journal for a scheduled review write      | [ck-0040.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0040.md) |
| ck-0041 | Extend manual compaction to the selected generation        | [ck-0041.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0041.md) |
| ck-0042 | Diagnose and prevent incomplete decision marker writes     | [ck-0042.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0042.md) |
| ck-0044 | Own questions by role on both harnesses                    | [ck-0044.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0044.md) |
| ck-0052 | Remove question attach and reask                           | [ck-0052.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0052.md) |
| ck-0053 | Remove question reconcile                                  | [ck-0053.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0053.md) |
| ck-0068 | Normalize app coordination and explicit role permissions | [ck-0068.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0068.md) |
