# Project documentation

## Organize project documentation

Link the repository README to `docs/README.md`. Use the latter as a short map of the
current requirements, technical design, and task history.

```text
README.md                    project overview and entry points
docs/
  README.md                  documentation map
  guides/
    README.md                setup and workflow map
    getting-started.md       setup and first use
  reference/
    README.md                lookup map
    <topic>.md               commands, configuration or work-file format
  design/
    README.md                current requirements and design areas
    <topic>.md                rules and rationale for a topic
  work/
    README.md                conventions and routes to work records
    <id>.md                   one request, its decisions and outcome
    index/<area>.md           optional topic work table
```

- Put current requirements and rationale under `docs/design/` or in one clearly linked
  authoritative document. Choose topic names that suit the project. Games can keep a
  full rulebook under `docs/design/gameplay/`. A small topic can be one file.
- Keep historical tasks at their existing `docs/work/<id>.md` paths. Move long tables to
  `docs/work/index/<area>.md` and link to the table from the design area. Existing inline
  tables remain valid.
- Give each rule or procedure one authoritative page. Link to it from navigation, setup
  guides, local agent instructions and skills, with a short cue about when to use it.
- For a changed or reverted requirement, update its authoritative text and link the new
  decision to its predecessor with `supersedes`. For a documentation correction, verify
  the approved requirement before editing.

## Audit a requirement

Give consequential requirements explicit stable anchors with the `rule-` prefix.
An optional `Evidence:` line links the implementation, authored data or tests. A
backticked work ID or decision ID on that line links the source of the decision.

```markdown
<a id="rule-jump-input"></a>

### Jump input

The game accepts a buffered jump on the first grounded frame.

Evidence: [Jump input tests](../../tests/input.test.ts), `game-0010/D1`.
```

Run the command from the repository to inspect, or pass its path with `--root`.

```sh
coordination-kit docs audit --area gameplay
coordination-kit docs audit --root /path/to/repository --format json
```

The audit reads committed documentation at the reported revision. It checks local
links and marked rules, then lists each marked rule as unverified. Inspect the
implementation and run a focused check or observe the actual interaction. Record the
same Git revision, rule ID, evidence, and one result for each rule.

| Result     | Meaning                                                                         |
| ---------- | ------------------------------------------------------------------------------- |
| Verified   | Evidence shows the behaviour matches the requirement.                           |
| Mismatch   | Evidence shows a difference between the behaviour and the approved requirement. |
| Unverified | Evidence is unavailable or insufficient. Record the next check.                 |

## Plan compaction

```sh
coordination-kit docs compact --area gameplay
coordination-kit docs compact --format json
```

Compaction defaults to planning. Explicit `--plan` runs the same read-only command.
Review the proposed changes against the reported revision. To mark a retired passage,
put `<!-- compact: superseded by game-0010 -->` immediately before its heading and cite
the approved replacement task. Terminal task records are candidates for owner review.
Check live work, acceptance, retained evidence and inbound links before shortening them.

Summarize eligible scope, criteria and outcomes in place. Preserve front matter,
decision lines, referenced headings, and a link to the full original record at its
Git revision. Apply the approved edits through the repository's normal review path
and run the audit again. The compaction plan is read-only.
