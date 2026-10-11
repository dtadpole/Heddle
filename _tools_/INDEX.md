---
title: Tools
version: 1.0.0
description: The scripts this repository runs on itself, kept out of the code it ships.
grounded_in:
  - source: human-authored
---

# `_tools_`

Type folder. Holds the machinery this repository uses to check itself: the verifier
runner and the helpers its checks share. Nothing here is part of the published
package — `package.json` ships `dist/` only — so a tool may depend on a fixture, a
scratch directory or a check file without any of it reaching a user.

## What belongs in it

Instances of `_tools_`, one per tool, each named kebab-case. Today there is one:
[`runner/`](runner/INDEX.md), which turns a check file into the project's verdict.
[`checks/`](checks/INDEX.md) sits beside it as the shared library its checks import.

A tool belongs here rather than under `src/` when its subject is *this repository*
rather than the harness. The test is the one the conventions give: if the package
were published tomorrow, would this file still be needed? A check that judges the
harness belongs to the harness; the runner that scores it belongs to the project.

## Read next

[`runner/INDEX.md`](runner/INDEX.md) for the exit contract every verifier keeps,
[`checks/INDEX.md`](checks/INDEX.md) for the shared helpers, and
[`_verifiers_/INDEX.md`](../_verifiers_/INDEX.md) for the ten verifications that use
both.
