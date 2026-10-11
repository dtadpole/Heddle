---
title: Verifier 2 — Streaming To A Web UI
version: 1.0.0
description: streaming text and reasoning appear in a browser while the model is still writing.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
---

# `20-streaming-web`

Instance of this project's `_verifiers_`. **The claim it decides:** streaming text and reasoning appear in a browser while the model is still writing.

A stream that is only visible after it ends is not a stream. This part judges that a text delta and a reasoning delta reach a client through the event stream **before** the turn completes, and that the same deltas are in the session record.

## What decides it

`check.mjs` opens the event stream, starts a turn against a double that emits its deltas slowly, and asserts the deltas arrive first.

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
