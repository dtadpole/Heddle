---
title: Verifier 7 — Workspaces And Sessions
version: 1.0.0
description: there are workspaces (folders) and sessions under a folder.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---

# `70-workspaces-sessions`

Instance of this project's `_verifiers_`. **The claim it decides:** there are workspaces (folders) and sessions under a folder.

A session belongs to a folder, and a folder has a record. This part judges that a workspace is created for a directory, that a session records the directory it ran in, and that sessions are grouped and listed under that folder.

## What decides it

`check-workspace.mjs` judges the workspace record and the grouping, and `check-session-store.mjs` judges the transcript itself: that it survives the process, resumes, and is appended to rather than rewritten.

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A
claim that could not be judged is never reported as holding, which is the runner's
whole reason for existing — see [`_tools_/runner/`](../../_tools_/runner/INDEX.md).

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Anything it has to spend to see.** Except where a check is named for the real
  backend, every fixture is local and the run is free.

## Read next

[`../INDEX.md`](../INDEX.md) for the ten verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
