---
title: DSH Conversation Views And The Trajectory Ledger
level: L2
version: 1.0.0
description: How DSH presents one session as two views, and what its Trajectory ledger is made of.
status: unverified
grounded_in:
  - source: the installed DSH 0.2.0-rc.2 packages under ~/.volta, read on 2026-10-11
  - source: '@deepseek-ai/dsh-client-ui-trajectory and dsh-client-ui-conversation, their READMEs and client bundles'
---

# DSH Conversation Views And The Trajectory Ledger

Read from the installed packages, because the owner asked heddle to match this and the shape is not
guessable — the interesting part is what the ledger is a *projection* of.

## Two views of one session, in a ring

The conversation surface hosts a **view ring**: the Chat view is the conversation as a reader follows it,
and the Trajectory view is the same session as an event ledger. The Trajectory package registers into that
ring rather than replacing it, and its README states the rule that matters most: the view is a **pure
projection** of the shared session window. It "neither reads nor changes the Chat conversation snapshot".

That is the design worth copying. Two views over one record cannot disagree about what happened; two stores
can, and reconciling them is work nobody asked for.

## What the ledger holds

Records are grouped by the **turn** and the **step** that produced them, and each record has a kind:

| kind | what it is |
|---|---|
| `user` | what the person asked |
| `assistant` | what the model answered |
| `tool` | one tool call |
| `subtool` | a call nested inside another |
| `compaction` | a request that summarised history, shown chronologically as *Between turns* when standalone and inside its turn when numbered |
| `system` | a prompt or instruction change, compared against the most recent request state |

Each record is timed off its own events. The names, from the bundle: `startedAt`, `durationMs`, `ttftMs`,
and a `usage` group with `inputTokens` and `outputTokens`. The README is explicit about the measures: TTFT
is from the Step start to its first token *including* an earlier retry attempt's output, and a metric is
**unavailable** — not zero — when the Step start is unloaded or the stream holds no token timestamps.

## The rules that are easy to get wrong

- **An in-flight record shows a start marker and no elapsed time.** "In-flight records show a start marker
  without inventing elapsed time." A duration for something still running is a fabrication, and it is the
  kind a reader would believe.
- **Missing is not zero.** An unavailable metric is blank. Printing `0` says "this cost nothing", which is a
  different and false claim.
- **The view follows the tail until the reader scrolls up**, then suspends following so arriving records do
  not move what is being read.
- **Long histories open at the current tail** and load earlier pages on demand, mounting only the visible
  rows. Heddle's ledgers are far shorter; this is recorded so the decision to skip it is deliberate.
- **The row's identity is the recorded tool name**, and the inspector opens the full input and output —
  including the original JSON arguments exactly as recorded, whitespace and all.

## What heddle already has for it

Heddle's session log is append-only and already carries what the ledger needs, which is why the projection is
cheap here:

| Ledger wants | heddle's event |
|---|---|
| a step boundary | `model/request`, with `at`, `messages`, `estimatedTokens`, `pruned`, `compacted` |
| a record's timing | the `at` of each event, and the gap to the next |
| output usage | `assistant/chunk` chunks carrying `usage: { inputTokens, outputTokens }` when the provider reports it |
| the settled answer | `assistant/completed`, with `text`, `reasoning`, `finishReason`, `rounds`, `denials` |
| a turn boundary | `turn/completed` with `rounds`, and `turn/retry` for a retried step |

So `estimatedTokens` on the request is the input the harness budgeted, and a provider-reported `usage` is the
truth when present — the same distinction the ledger makes between a measured number and an unavailable one.

## Read next

[`dsh-mechanisms/`](INDEX.md) for the rest of these readings,
[`../../_verifiers_/85-trajectory-view/INDEX.md`](../../_verifiers_/85-trajectory-view/INDEX.md) for the
claims heddle holds itself to, and
[`dsh-webui.md`](dsh-webui.md) for the server and token this view is served behind.
