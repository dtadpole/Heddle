---
title: Verifier 7 — Workspaces And Sessions
version: 1.1.0
description: a workspace names a target folder, a session is bound to a folder under it, and those folders form a recursive tree.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
  - source: owner statement in the dsh session, 2026-10-11, choosing containment, one session per folder, every folder in the tree, and kind icons with type badges
  - source: SESSION_TREE.md, the design this part judges
---

# `70-workspaces-sessions`

Instance of this project's `_verifiers_`. **The claim it decides:** a workspace names a target folder,
a session is bound to a folder under it, and the folders form a recursive tree whose nodes are named
and classified by the conventions repository's own rules.

A session records the folder it ran in, and the workspace above that folder accounts for it. This part
also judges the navigation that follows from it: that the workspace with the **longest root above** a
folder owns its session, that one folder holds one session, and that the tree classifies each folder
and lists one level at a time. The model is stated in full, with the decisions behind it and what was
rejected, in [`../../SESSION_TREE.md`](../../SESSION_TREE.md).

## What decides it

`check.mjs` — one file, nineteen checks in three groups:

| Group | Checks | What it judges |
|---|---|---|
| the transcript | 4 | a session outlives its run, resumes, is readable on disk, and is appended to rather than rewritten |
| the association | 3 | a session is grouped under the folder it ran in, a subdirectory is a member of the root above it, and one folder's prompts continue one session |
| the tree | 12 | containment, the segment-wise trap, the nearest root, `--new` and history, one level at a time, type and instance classification, badges, recursion, plain containers, plumbing and generated folders, the folder name as the session name, an empty type folder, and a folder outside every root |

## Where it stands, 2026-10-11

**5 pass, 14 unjudged, verdict `3`.** The tree group is written and reports **unjudged** rather than
failing, because the mechanism it judges was not built when the checks were written — the owner asked
for the checks first. `3` is the honest verdict for that, and it is not a pass: the part does not
claim to hold until the mechanism exists. Two of the three association checks changed in the same pass
and say so in their own comments, because the owner reversed the equality rule this part used to
assert.

## Running it

```bash
sh verify.sh            # every check, with the verdict
sh verify.sh --list     # the check names, and why any was unjudged
sh verify.sh --json     # one parseable object
```

Exit `0` when the claim holds, `1` when it fails, `3` when it could not be judged. A
claim that could not be judged is never reported as holding, which is the runner's
whole reason for existing — see [`_tools_/verify-runner/`](../../_tools_/verify-runner/INDEX.md).

## What it deliberately does not judge

- **How well a model reasons.** Nothing here scores an answer's quality; the checks
  ask whether the mechanism works.
- **Anything it has to spend to see.** Every fixture here is a scripted endpoint and a local
  directory tree, so the run is free and offline.
- **A rendered page.** The tree is judged as a **derivation**, one level at a time, through the CLI —
  which is where the mechanism lives and where a browser is not needed. The pixels, the icons and the
  `+` / `−` control are not judged here; the roadmap's "a browser check" is still open.

## Read next

[`../../SESSION_TREE.md`](../../SESSION_TREE.md) for the model these checks judge, and
[`../INDEX.md`](../INDEX.md) for the twelve verifications, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the part this one decides.
