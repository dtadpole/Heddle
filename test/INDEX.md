---
title: Tests
version: 1.0.0
description: The framework's own unit suite, which the goal's verifiers assume rather than repeat.
grounded_in:
  - source: human-authored
---

# `test`

The project's unit suite, run by `npm test` through Node's own runner over `test/*.test.ts`. One file
per primitive, each with one job; the two the framework itself is built on come first:

- `boot.test.ts` pins the **framework primitives** the harness is built on — that a Cordis plugin whose
  `inject` is missing stays pending, that a config schema is validated before a plugin body runs, that
  disposal takes a service offline with its fiber.
- `web.test.ts` pins the two pure decisions behind the Web UI: how a recorded session folds into display
  turns, and which refusal a caller is shown. Both have rules that are easy to get subtly wrong and cheap
  to state in isolation — that the fold reads the deltas rather than the settled completion, so an answer
  is never printed twice, and that a caller with no token and a caller with a stale one are told apart.
- `tree.test.ts` pins the folder tree's three rules without a store or a CLI: the type badge that has to
  keep the three `_con…_` types apart, the classification that depends on a folder's **parent** (one word
  is not an instance name), and the containment compared by path segment rather than by string. The rest
  — `ledger.test.ts`, `meter.test.ts`, `prune.test.ts`, `surface.test.ts` — arrived with the mechanisms
  they pin.

## What belongs in it, and what does not

A unit test here judges *the framework's behaviour in isolation*: one context, one
plugin, no model, no network, no fixture beyond what it builds itself.

A claim in [`_verifiers_/`](../_verifiers_/INDEX.md) judges **the delivered harness**:
it drives the built CLI, a real endpoint or a local double, and a real session. The
line is drawn by what is being judged rather than by size — a verifier that re-tested
Cordis would be testing a dependency, and a unit test that drove the CLI would be a
worse verifier.

## Read next

[`boot.test.ts`](boot.test.ts) for the four behaviours the scaffold already pinned,
and [`_verifiers_/INDEX.md`](../_verifiers_/INDEX.md) for the ten claims about the
harness itself.
