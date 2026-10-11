---
title: Context
version: 1.0.0
description: How a model call's messages are assembled, budgeted, pruned and compacted.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, that context and prompt composition must follow DSH
---

# `context`

Holds [`assembler.ts`](assembler.ts) and [`service.ts`](service.ts), which together
decide what a model is actually sent. Modelled on `@deepseek-ai/dsh-*`'s
compaction engine, its tool-result pruner and its session projection, in the small.

## What belongs here

- **The assembly order** — system prompt, then project instructions, then the session's
  history with any compaction replacement applied.
- **The token meter** — a four-characters-per-token estimate with fixed per-message and
  per-block overhead, which is what DSH uses when it has no count. The budget is what
  the estimate says; a provider's usage is a cross-check, never the gate.
- **Pruning** — a tool result over the threshold is cut to head, marker and tail, before
  anything is summarised, because trimming one huge result costs less meaning than
  summarising twenty small ones.
- **Compaction** — when the assembly reaches the threshold, the older span is summarised
  and **shadowed**, not deleted. DSH writes `compaction/start`, `compaction/summary`, a
  replacement message and `compaction/end`, and keeps the shadowed events so a replay is
  exact; this does the same, and `heddle transcript` still shows everything.

## The numbers, and where each came from

| Constant | Value | Source |
|---|---|---|
| `CHARS_PER_TOKEN` | 4 | DSH's local heuristic |
| `ROLE_OVERHEAD`, `BLOCK_OVERHEAD` | 4, 4 | DSH |
| `THRESHOLD_RATIO` | 0.8 | DSH's compaction threshold |
| `RETAIN_RATIO` | 0.16 | DSH's retained tail, required to be below the threshold |
| `PRUNE_THRESHOLD_CHARS` | 8192 | DSH's pruner |
| `PRUNE_HEAD_CHARS`, `PRUNE_TAIL_CHARS` | 4096, 1024 | DSH's pruner |
| `INSTRUCTIONS_MAX_BYTES` | 65536 | DSH's instruction budget |

## Read next

[`../session/INDEX.md`](../session/INDEX.md) for the log this reads,
[`../llm/INDEX.md`](../llm/INDEX.md) for the request it produces, and
[`../../_verifiers_/30-context-management/INDEX.md`](../../_verifiers_/30-context-management/INDEX.md)
for the claim it decides.
