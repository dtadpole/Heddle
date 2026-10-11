---
title: Stream
version: 1.0.0
description: The live view of a turn, on the terminal and through the event stream.
grounded_in:
  - source: human-authored
---

# `stream`

Holds [`printer.ts`](printer.ts), which subscribes to `session/event` and writes reasoning
and content deltas to standard error as they are appended.

It exists as a first-class surface rather than a debugging leftover because **streaming must
be judgeable without a browser**: a claim that can only be checked through a UI breaks
whenever the UI does. The Web UI subscribes to the same event, so the two views cannot
disagree.

## Read next

[`../INDEX.md`](../INDEX.md) for the source tree, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the claims that decide it.
