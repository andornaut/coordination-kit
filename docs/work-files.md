# Work files

`work check` validates a repository's design index tables and work files against the work-file
convention; `work report` lists each work item's milestone, joined with live protocol state when
a coordinator root is available. The convention itself is in
[docs/work/](https://github.com/andornaut/coordination-kit/blob/main/docs/work/README.md). Both
commands only read.

`--root DIR` names the repository (default: the working directory). The coordinator root comes
only from `COORDINATION_KIT_ROOT`, else `DELIVERY_KIT_ROOT`, so a session's coordinator variable
never redirects which repository is checked.

## work check

```sh
coordination-kit work check --root /path/to/repository
```

The repository's work items are `docs/work/*.md` other than `docs/work/README.md`. A design index
is any table in `docs/design/*.md` whose header is exactly `ID | Title | Link`. A row links its
work file by a path relative to the design file, or by the repository's blob URL on `main`,
`https://github.com/OWNER/REPO/blob/main/docs/work/<id>.md`, where `OWNER/REPO` comes from the
`repository` field of the repository's `package.json`. A URL of another location does not
resolve. The check reports:

| Code                                                  | Rule                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `unindexed`, `index-duplicate`, `index-area-mismatch` | Every work file is indexed exactly once, in the table of its `design` area.                                                          |
| `index-link-unresolved`, `index-id-mismatch`          | Every indexed link resolves within the repository, and the row's ID is the linked item's `id`.                                       |
| `front-matter-missing`, `front-matter-invalid`        | The file opens with a `---` block of `key: value` lines; a list is `[a, b]`.                                                         |
| `field-missing`, `field-invalid`, `field-unknown`     | `id`, `title`, `status`, `approved` and `design` are present and non-empty; `related` and `supersedes` are the only optional fields. |
| `status-invalid`                                      | `status` is `proposed`, `approved`, `done`, `declined`, `cancelled` or `superseded`.                                                 |
| `id-invalid`, `id-mismatch`, `id-duplicate`           | `id` is a prefix and a zero-padded sequence (`ck-0001`), equals the file name and is unique.                                         |
| `design-unknown`                                      | `design` names an existing `docs/design/<area>.md`.                                                                                  |
| `supersedes-missing`                                  | A `supersedes` target is an existing work item.                                                                                      |
| `home-path`, `session-uuid`                           | No work file, design file or the convention document contains a home-directory absolute path or a UUID.                              |
| `work-dir-missing`                                    | `docs/work/` exists.                                                                                                                 |

Stdout is one JSON object: `ok`, `workItems`, `designAreas` and `findings`, each finding with its
`path`, optional `line`, `code` and `message`. Each finding is also named on stderr as
`coordination-kit: PATH[:LINE]: CODE: MESSAGE`. A finding never echoes the matched path or UUID.
The command exits 0 with no findings and 1 otherwise.

## work report

```sh
COORDINATION_KIT_ROOT=/path/to/game-coordinator coordination-kit work report --root /path/to/repository
```

Stdout is one JSON object. `items` lists each work file's `path`, `id`, `title`, `status` (the
front-matter milestone as written, any of the six) and `design`. The derived, cross-repository
view with delivery evidence is [`status`](commands.md#status). `coordinator.status` is:

- `absent`: no coordinator root was named; the report is front matter only.
- `unconfigured`: the coordinator has no work protocol configuration; front matter only.
- `available`: each item adds `publications`, every work publication in any claimed role whose
  definition ID equals the item's `id` or whose plan `path` is the item's `path`. Each lists
  `joinedBy` (`id`, `path` or both), the plan's `path` and `commit` (null when absent), its
  `role`, `revision`, `ready`,
  `receiptsSatisfied` (every criterion phase and consumer has a passed receipt; null when the
  publication cannot be evaluated) and `requests`, each linked request's ledger `state` or
  `unknown`. An empty list means no publication uses that ID.
- `unavailable`, with a `reason`: the coordinator or its protocol state could not be read; front
  matter only, and the command exits 1. Unavailable state is never reported as absent work.

A work publication is joined when its definition ID is the work file's `id`, or when its plan
names the work file by repository-relative `path`; see
[work definitions and receipts](work-protocol.md#work-definitions-and-receipts). The `commit` is
reported, not checked against the repository, and neither field grants approval. A publication
under another ID without a plan path is not listed.
