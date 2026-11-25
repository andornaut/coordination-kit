# Work protocol

An explicitly activated work protocol keeps fenced role publications, canonical message
originals and recipient handling receipts under one external `stateRoot`, outside every source
checkout. Each role writes only its own namespace under its claimed epoch. Enrollment receipts
reference existing records rather than copying their state. Representation, active adoption
and coverage completeness are reported separately, and runtime admission is role-local: a role
needs its own current active receipt and the specific approved work reference. Request
accounting tracks requested outcomes separately from message delivery and handling. Migration
copies legacy state byte-exact after a verified backup and restore.

Retired in 3.0 ([simplification](simplification.md#phase-4-thin-protocol-and-retirement)); the
state is in the Phase 4 archive ([retirement](../store.md#retirement)).

## Work items

| ID      | Title                                                 | Link                                                                                       |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ck-0002 | Add a self-enrollment command                         | [ck-0002.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0002.md) |
| ck-0003 | Add protocol-mode message and work shortcuts          | [ck-0003.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0003.md) |
| ck-0007 | Add path and commit fields to work plan artifacts     | [ck-0007.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0007.md) |
| ck-0008 | Remove ledger writer contention                       | [ck-0008.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0008.md) |
| ck-0013 | Stop restated intake from appearing as new references | [ck-0013.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0013.md) |
| ck-0014 | Report closed historical work as done                 | [ck-0014.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0014.md) |
| ck-0015 | Report the cause of failed protocol commands          | [ck-0015.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0015.md) |
| ck-0046 | Finish work items that were superseded or cancelled   | [ck-0046.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0046.md) |
