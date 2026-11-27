---
name: coordination-lifecycle
description: Run approved work through Coordination Kit in a standalone Git repository, from task intake and ownership through review, merge and exact-commit landing verification.
---

# Coordination lifecycle

Use the project's pinned Coordination Kit CLI. Run commands from the primary checkout or pass its path with `--root`. Read `coordination-kit.json` for the project roles and review policy. The installed package's `docs/standalone.md` covers setup, review and landing commands.

1. Identify the task with `task list` and `task show ID`. If it has no record, use `task propose` with the requested scope and owner. The maintainer uses `task approve` with a reference to the user's actual build approval. The assigned owner runs `task start ID` after prerequisites land.
2. Work on the approved scope in its own branch. Use `task work-file ID` to prepare `docs/work/ID.md` and commit it with the implementation. Run the repository's checks and record the candidate branch, exact head, summary and evidence with `task ready`.
3. Follow the candidate's review policy. Under `off`, use `task merge` after the project checks. Under `chat`, present the candidate and have the maintainer record explicit user approval for that exact head with `task approve-review` before `task merge`. Under `pr`, publish the candidate and use `task open-review` when authorized to create the review. The user can merge in the forge, or the maintainer can record approval of the exact revision for an authorized agent merge. Check the current candidate if either the head or policy changes.
4. Follow the merge through the repository's current landing checks. Record evidence for the integrated commit with `task verify`, then confirm `task show ID` reports `landed` and the verified SHA. Keep ownership while checks are pending or a failure remains unresolved.
