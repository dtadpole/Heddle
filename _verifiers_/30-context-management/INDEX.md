---
title: Verifier 3 — Context Management
version: 1.0.0
description: context and prompt are composed with retention, a budget and compaction.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---

# `30-context-management`

Instance of this project's `_verifiers_`. **The claim it decides:** context and prompt are composed with retention, a budget and compaction.

A harness that sends the whole transcript forever eventually cannot send anything. This part judges the order in which a model call's messages are assembled, that a system prompt and instructions lead it, that a token budget is enforced, and that exceeding it produces a compaction event rather than a failure.

## What decides it

`check.mjs` drives turns against a scripted endpoint with a deliberately small budget and reads the transcript to see what was sent and what was compacted.

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
