# Work files

`work check` validates a repository's design index tables and work files. `work report` lists each
work item's milestone, joined with live protocol state when a coordinator root is available.
These commands read the repository's [indexed work records](https://github.com/andornaut/coordination-kit/blob/main/docs/work/README.md).
Each item's live progress is recorded with the `work` store verbs
([work records](store.md#work-records)).

This guide covers the indexed work-file convention used by shared workspaces. The
[standalone task workflow](standalone.md#approve-and-build) renders its own work file with
`task work-file` and tracks approval and review with `task` commands.

`--root DIR` names the repository (default: the working directory). The coordinator root comes
only from `COORDINATION_KIT_ROOT`, else `DELIVERY_KIT_ROOT`, so a session's coordinator variable
never redirects which repository is checked.

## Work-item structure

Indexed work files have Scope, Criteria, Decisions, References, Verification and Outcome sections.
Criteria describe the required behaviour. Decisions state what was decided and why. Use the
[decision-line format](#decision-lines). Front matter identifies and indexes the item.
In References, link to the design page and any related or superseded records using paths
relative to the work file. Keep their IDs in front matter for tools that read the index.

| Front matter | Content                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `id`         | The repository's prefix and a zero-padded sequence, such as `ck-0001` in Coordination Kit.                                |
| `title`      | A short imperative title.                                                                                                 |
| `status`     | `proposed`, `approved`, `done`, `declined`, `cancelled` or `superseded`.                                                  |
| `approved`   | A short approval reference, such as `user, 2026-11-18`; for `proposed` and `declined`, the request or decision reference. |
| `design`     | The design area in `docs/design/`.                                                                                        |
| `related`    | A list of related work IDs.                                                                                               |
| `supersedes` | The ID of the item this one replaces; omitted otherwise.                                                                  |
| `owner`      | The registry role that owns the item, when the repository's roles leave it ambiguous; omitted otherwise.                  |

## Verification

For new approved implementation work, write the Verification section immediately above Outcome
before building.
Name the check or scenario, expected result, and evidence to record. Include failure and retry
cases where relevant. Match the plan to the change. For a docs-only task, checking the changed
links or validating the affected command example can be enough.

Record what actually passed on the exact revision and identify any failed, skipped or pending
checks in Outcome. Link durable evidence and keep the detailed logs at those references.
Standalone tasks also record actual results through [task evidence](standalone.md#approve-and-build).
Existing finished items keep their original record.

For example, a work item that validates input might record the following.

```markdown
## Criteria

Reject blank names and save valid names.

## References

- Design: [Coordination](../design/coordination.md)
- Related: [ck-0001](ck-0001.md)
- Supersedes: [ck-0047](ck-0047.md)

## Verification

Run the focused input checks. Expect a validation error and no write for a blank name.
Retry with a valid name and expect it to be saved. Record the test report for the tested commit.

## Outcome

The blank-name and valid-retry cases passed on commit `0123456789abcdef0123456789abcdef01234567`.
Evidence is recorded at `ci:run-42/input-checks`.
```

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
