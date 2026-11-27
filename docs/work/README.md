# Work items

This directory records requests, approved scope, decisions and outcomes. Each request has one
file, `<id>.md`. Find work by area through the [design index](../design/README.md). Area tables
live in the design summaries or, for a longer table, `index/<area>.md`. Live progress (start,
blocks, stage evidence and finish) is recorded in the coordination store with the `work` verbs.
See the [documentation index](../README.md) for the operating guides.

Use the [work-file format](../reference/work-files.md#work-item-structure) for front matter and sections,
including the [Verification plan](../reference/work-files.md#verification).

- Every user request gets a work file. A request not yet approved is a `proposed` stub; a refused
  one becomes `declined`, and an approved one `approved`.
- Only `main` edits design index tables and approved scope. Approval, or a `proposed` stub,
  commits the work-file stub and its index row on `main`, and that commit allocates the ID.
- Workers edit only their own work file and the design prose that ships with their feature.
  Integration sets `status: done` in the merge.
- A changed or reverted decision is a new work item with `supersedes`. A finished item's outcome
  is never rewritten.
- Work files are public: no session IDs, hostnames, local home-directory paths or quoted
  conversation, only short approval references.
- `coordination-kit work check` validates the indexed file structure in `make lint` and CI
  ([work files](../reference/work-files.md)).
- Docs-only changes run only the attribution and lint checks.
- Work files are not part of the npm package.
