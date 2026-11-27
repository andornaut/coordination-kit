# Design

This directory records the kit boundaries, design rationale and current requirements. Its
Markdown files are organized by topic. Each area keeps its work table or links to it.
See the [documentation index](../README.md) for operating guides. Work records and conventions are in
[docs/work/](https://github.com/andornaut/coordination-kit/blob/main/docs/work/README.md).

| Area                                | Covers                                                                                                   | Topic docs                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [coordination](coordination.md)     | The kit boundary, the one-way seam with delivery-kit, shared utilities and the work files                | [review](../review.md), [libraries](../libraries.md), [work files](../work-files.md)         |
| [messages](messages.md)             | Store messages: send, pull, close and wakes                                                              | [messages](../messages.md), [commands](../commands.md)                                       |
| [review](review.md)                 | The review route, the runner seam, the stored brief and the Claude channel                               | [review](../review.md), [commands](../commands.md)                                           |
| [registry](registry.md)             | The role registry, harness selection, send-time resolution and readiness                                 | [registry](../registry.md)                                                                   |
| [work-protocol](work-protocol.md)   | Retired in 3.0: fenced publications, receipts, enrollment and accounting                                 | [store](../store.md#retirement)                                                              |
| [packaging](packaging.md)           | The CLI bundle, public build APIs, checks, CI, package contents, releases and the docs                   | [libraries](../libraries.md), [upgrading](../upgrading.md), [development](../development.md) |
| [simplification](simplification.md) | The approved plan to replace the message, ledger and protocol stores with one store and one message path | [messages](../messages.md), [store](../store.md)                                             |
