# Work files

`work check` validates a repository's design index tables and work files against the work-file
convention; `work report` lists each work item's milestone, joined with live protocol state when
a coordinator root is available. The convention itself is in
[docs/work/](https://github.com/andornaut/coordination-kit/blob/main/docs/work/README.md). Both
commands only read. Each item's live progress is recorded with the `work` store verbs
([work records](store.md#work-records)).

`--root DIR` names the repository (default: the working directory). The coordinator root comes
only from `COORDINATION_KIT_ROOT`, else `DELIVERY_KIT_ROOT`, so a session's coordinator variable
never redirects which repository is checked.

## work check

```sh
coordination-kit work check --root /path/to/repository
coordination-kit work check --decisions --root /path/to/repository
```

The repository's work items are `docs/work/*.md` other than `docs/work/README.md`. An area's work
index can live in `docs/design/<area>.md` or `docs/work/index/<area>.md`. Both use the header
`ID | Title | Link`. In either location, a row links its work file relative to the index file or
uses the repository's blob URL on `main`,
`https://github.com/OWNER/REPO/blob/main/docs/work/<id>.md`, where `OWNER/REPO` comes from the
`repository` field of the repository's `package.json`. A URL of another location does not
resolve. The check reports:

| Code                                                  | Rule                                                                                                                                                                                                                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unindexed`, `index-duplicate`, `index-area-mismatch` | Every work file is indexed exactly once, in the table of its `design` area.                                                                                                                                                                                |
| `index-link-unresolved`, `index-id-mismatch`          | Every indexed link resolves within the repository, and the row's ID is the linked item's `id`.                                                                                                                                                             |
| `front-matter-missing`, `front-matter-invalid`        | The file opens with a `---` block of `key: value` lines; a list is `[a, b]`.                                                                                                                                                                               |
| `field-missing`, `field-invalid`, `field-unknown`     | `id`, `title`, `status`, `approved` and `design` are present and non-empty, except that a `proposed` or `declined` item needs no `approved`; `related`, `supersedes` (one ID or a list) and `owner` (one registry role name) are the only optional fields. |
| `decision-invalid`                                    | Every bullet of a Decisions section that starts with `- D` and a digit is a [decision line](#decision-lines) with a calendar date, a unique `D<n>` and a local `supersedes` target that exists.                                                            |
| `decision-unrecorded`, `decisions-unavailable`        | With `--decisions`: every store decision of this repository's items is in its work file; the store could not be read.                                                                                                                                      |
| `status-invalid`                                      | `status` is `proposed`, `approved`, `done`, `declined`, `cancelled` or `superseded`.                                                                                                                                                                       |
| `id-invalid`, `id-mismatch`, `id-duplicate`           | `id` is a prefix and a zero-padded sequence (`ck-0001`), equals the file name and is unique.                                                                                                                                                               |
| `design-unknown`                                      | `design` names an existing `docs/design/<area>.md`.                                                                                                                                                                                                        |
| `supersedes-missing`                                  | Every `supersedes` target is an existing work item.                                                                                                                                                                                                        |
| `home-path`, `session-uuid`                           | No work file, design file or the convention document contains a home-directory absolute path or a UUID.                                                                                                                                                    |
| `work-dir-missing`                                    | `docs/work/` exists.                                                                                                                                                                                                                                       |

Stdout is one JSON object: `ok`, `workItems`, `designAreas` and `findings`, each finding with its
`path`, optional `line`, `code` and `message`. Each finding is also named on stderr as
`coordination-kit: PATH[:LINE]: CODE: MESSAGE`. A finding never echoes the matched path or UUID.
The command exits 0 with no findings and 1 otherwise.

`--decisions` reads the store's decision records through the coordinator from
`COORDINATION_KIT_ROOT` or `DELIVERY_KIT_ROOT`, and reports each one that the work file in the
checked worktree does not record.

## Decision lines

A decision is one bullet in the work file's Decisions section:

```markdown
- D2 (user, 2026-11-18; answers q-coordination-kit-14; supersedes D1): Short decision text.
```

`D<n>` numbers the item's decisions. The parenthesis names who decided (`user` or a registry role
name) and the date, then optionally the question it answers and the decision it supersedes, in
that order: `D1` within the item, or `ck-0006/D1` in another. Other bullets in the section are
prose. The [decision graph](store.md#decision-graph) reads these lines from each repository's
`main`.

## work report

```sh
COORDINATION_KIT_ROOT=/path/to/game-coordinator coordination-kit work report --root /path/to/repository
```

Stdout is one JSON object. `items` lists each work file's `path`, `id`, `title`, `status` (the
front-matter milestone as written, any of the six) and `design`. The derived, cross-repository
view with delivery evidence is [`status`](commands.md#status), and an item's live progress is
`work show`. `coordinator.status` is `absent` when no coordinator root was named, `available`
when it loads, and `unavailable` with a `reason` otherwise, which exits 1.
