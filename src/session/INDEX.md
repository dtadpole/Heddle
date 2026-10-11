---
title: Session
version: 1.2.0
description: The session store and its service — an append-only event log per session, the surface a request is derived from, and the folder tree a session is found in.
grounded_in:
  - source: human-authored
---

# `session`

The session store and its service — an append-only event log per session.

Three things live here and they are deliberately together, because each is a property of the log. The
**log** is append-only: every event a run produces, in order, on disk before the thing
it describes happens. The **surface** is the positional view of that log which a model request is
derived from — only message-producing events take a position — a `message` a person or a
model produced, a `context/note` the harness wrote, or one node per streamed run — and a rewrite
(`surfaceOp: 'replace'`) shadows a span of positions instead of erasing it. A span is **positional**:
its seqs need not be in order, because a replacement carries a higher seq than what it shadows, and
`start` may be greater than `end`. That is what lets a compaction or a pruning change
what the model sees while `heddle transcript` still shows everything that happened. The **tree**
([`tree.ts`](tree.ts)) is what a store of sessions looks like as folders: it classifies each folder by
the conventions' own rules — a type folder, an instance of one, a plain container, a generated folder —
and answers one level at a time, with a session row only where the type-plus-instance pattern matches.
[`../../SESSION_TREE.md`](../../SESSION_TREE.md) states that model and the owner's decisions behind it.

Everything built on top of it — the meter, the pruner, the compaction, `heddle context` — reads
`deriveMessages()` rather than filtering the log, and [`../context/INDEX.md`](../context/INDEX.md) is
where that happens.

This is a source folder rather than a type folder: it carries code, not instances of a
registered content type. Its entry point exists so that a reader who opens it learns
what belongs here and what to read next, which is the same duty every `INDEX.md` in
this tree carries.

## Read next

[`../../README.md`](../../README.md) for how the layout fits together, and
[`../../_verifiers_/INDEX.md`](../../_verifiers_/INDEX.md) for the claims that decide
whether what lives here works.
