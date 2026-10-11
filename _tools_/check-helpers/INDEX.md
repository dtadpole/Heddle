---
title: Check Helpers
version: 1.0.0
description: The fixtures and doubles every verifier check shares, so no check invents its own.
grounded_in:
  - source: human-authored
---

# `check-helpers`

Holds [`lib.mjs`](lib.mjs), the library every check file imports. It exists so that
three rules are stated once instead of ten times.

- **Fixtures live under `.heddle-tmp/` inside this checkout.** Measured: the Cordis
  loader imports a plugin by absolute path, so a fixture under `/tmp` cannot resolve
  `@deepseek-ai/cordis` and fails to load, and Node strips TypeScript types by
  extension, so a generated plugin fixture must be `.ts` while a check file itself is
  plain JavaScript.
- **Nothing spends anything.** `scriptedConfig` points an endpoint at a JSON file of
  steps and `chatDouble` / `responsesDouble` are local HTTP servers that speak the
  provider's real wire shape, so a check that drives a turn is offline and
  reproducible.
- **A check that cannot judge says so.** `skipUnless` turns a missing mechanism into a
  labelled skip, which the runner counts as unjudged rather than as a pass.

## What belongs in it

A helper used by two or more checks, or a rule that a check must not be free to
restate. A fixture used by exactly one check stays in that check's folder.

## Read next

[`../verify-runner/INDEX.md`](../verify-runner/INDEX.md) for the verdict the helpers feed, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the ten claims.
