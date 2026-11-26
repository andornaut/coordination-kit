# Packaging

The package is `@andornaut/coordination-kit`. `dist/cli.js` is the only runtime entry point and
imports only `node:` builtins; the public build APIs are explicit `build/` subpaths whose bundles
share their common modules through `dist/chunks/`, so every subpath sees one instance of each
module. The npm package ships `dist/`, the README, the topic docs, the design summaries,
`LICENSE` and `SOURCE_COMMIT`; work files are not packaged, so packaged docs link to them by
their repository URL, and lint checks the packaged docs against `package.json` `files`. The
`make` targets run every check in stock containers with the checkout bound read-only, and CI runs
the same npm commands natively, with docs-only changes limited to lint. Releases are cut from `main` only after every required CI
workflow passes on the exact commit, and a published tag is never moved. Public interfaces and
on-disk formats follow semver.

Reference: [libraries](../libraries.md), [upgrading](../upgrading.md),
[Developing](../../README.md#developing), [Compatibility and releases](../../README.md#compatibility-and-releases).

## Work items

| ID      | Title                                                            | Link                                                                                       |
| ------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ck-0011 | Check packaged docs on docs-only changes                         | [ck-0011.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0011.md) |
| ck-0012 | Link packaged docs to unpackaged work files on GitHub            | [ck-0012.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0012.md) |
| ck-0047 | Refactor for structure, encapsulation and simplicity             | [ck-0047.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0047.md) |
| ck-0048 | Check import cycles in scripts and tests                         | [ck-0048.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0048.md) |
| ck-0049 | Test internals through their module interfaces                   | [ck-0049.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0049.md) |
| ck-0050 | One command wrapper and explicit clock, environment and hostname | [ck-0050.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0050.md) |
| ck-0054 | Reject inline type-only imports that load their module | [ck-0054.md](https://github.com/andornaut/coordination-kit/blob/main/docs/work/ck-0054.md) |
