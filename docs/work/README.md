# Work items

Each approved task is one file, `docs/work/<id>.md`. It records scope and milestones; live
progress (start, blocks, stage evidence and finish) is recorded in the coordination store with the
`work` verbs. The
[design index](../design/README.md) lists the work items of each area.

| Front matter | Content                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `id`         | `ck-` and a zero-padded sequence (`ck-0001`), allocated in chronological order.                                           |
| `title`      | A short imperative title.                                                                                                 |
| `status`     | `proposed`, `approved`, `done`, `declined`, `cancelled` or `superseded`.                                                  |
| `approved`   | A short approval reference, such as `user, 2026-11-18`; for `proposed` and `declined`, the request or decision reference. |
| `design`     | The design area in `docs/design/`.                                                                                        |
| `related`    | A list of related work IDs.                                                                                               |
| `supersedes` | The ID of the item this one replaces; omitted otherwise.                                                                  |
| `owner`      | The registry role that owns the item, when the repository's roles leave it ambiguous; omitted otherwise.                  |

The sections are Scope, Criteria, Decisions and Outcome. Decisions and Outcome state what was
decided or delivered, and why, in a line or two each. A decision line is
`- D<n> (BY, YYYY-MM-DD[; answers Q][; supersedes Dk]): text`.

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
- `coordination-kit work check` enforces this convention in `make lint` and CI
  ([work files](../work-files.md)).
- Docs-only changes run only the attribution and lint checks.
- Work files are not part of the npm package.
