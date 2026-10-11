---
title: DSH Mechanisms
version: 1.0.0
description: How DeepSeek Harness implements each mechanism heddle mirrors, read from the installed packages.
grounded_in:
  - source: the installed DSH packages under ~/.volta, read on 2026-10-11
  - source: the live store at ~/.dsh for the workspace and session shapes
---

# `dsh-mechanisms`

Instance of [`_context_`](../INDEX.md). Holds the reading behind every mechanism this harness
mirrors: how DSH streams a model call, how it assembles and compacts context, what a hook is
there, how it serves and protects its Web UI, and how it models workspaces and sessions.

## Why this is kept

The instruction was to follow how DSH does it rather than to invent a shape, and these five
reports are what that meant in practice — each is a reading of the installed packages, with the
file paths, type names and measured constants that a design decision actually turned on. They are
**gathered material**, not authored conclusions: the conclusions are in the code and in
[`_verifiers_/`](../../_verifiers_/INDEX.md), and a report here is only as good as the version of
DSH it read.

They first lived in a git-ignored scratch directory, which was wrong for the durable-work rule this
repository follows: anything worth citing does not stay somewhere a reboot discards. An instance of
`_context_` is the registered home for gathered material, so they moved here unchanged apart from
the frontmatter every authored artifact carries.

## What belongs in it

- [`dsh-streaming.md`](dsh-streaming.md) — the seven-variant chunk union, the assembler, reasoning as
  a first-class block, the WebSocket mux, and how a partial answer reaches a browser without ever
  entering the log.
- [`dsh-context.md`](dsh-context.md) — the request's message list, the token meter's constants, the
  four pruning and compaction events, and the instruction files.
- [`dsh-hooks.md`](dsh-hooks.md) — the event points around a model and a tool call, their dispatch
  modes, and the rule that a listener is an effect of the fiber that registered it.
- [`dsh-webui.md`](dsh-webui.md) — the raw `node:http` server, the default port, the launch token
  exchanged for a cookie, and the Host and Origin fence that runs before any secret is compared.
- [`dsh-workspaces.md`](dsh-workspaces.md) — the workspace record, the bucket-naming rule, the
  equality that decides membership, and the session tree.

## Read next

[`../INDEX.md`](../INDEX.md) for the `_context_` type, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts these readings ground.
