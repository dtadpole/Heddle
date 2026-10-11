---
title: Workspace
version: 1.0.0
description: Workspaces as folders with records, and the sessions grouped under them.
grounded_in:
  - source: human-authored
---

# `workspace`

Holds [`service.ts`](service.ts), modelled on DSH's `dsh-workspace`. A workspace is both a
folder and a record — `{ id, path, title, sessionIds, createdAt, updatedAt }` — and a session
belongs to the workspace whose path **equals** its working directory, not one that contains
it. Order lives in arrays rather than in a field on each record, and `bootstrap` adopts
sessions recorded before the workspace existed, which is what makes the model self-healing.

## Read next

[`../INDEX.md`](../INDEX.md) for the source tree, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the claims that decide it.
