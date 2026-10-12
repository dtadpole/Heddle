---
title: The Session Record And Its Projections
level: L2
version: 1.0.0
description: How one session log, its surface, its trajectory and its meta record are made to agree, and which of them is authoritative for what.
status: unverified
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for heddle sessions to be lined up with the trajectory view and with context management
  - source: the working tree of this repository, read 2026-10-11, for the contracts of src/session/store.ts, src/session/transcript.ts, src/server/ledger.ts and src/context/service.ts
  - source: _context_/dsh-mechanisms/dsh-context.md and dsh-workspaces.md, for how DSH separates a log from its projections
---

# The session record and its projections

Heddle already keeps one append-only log per session, and it already reads that log three ways. What it
has never stated is **which way is authoritative for what**, so the three can disagree — and today they
do, in ways a person notices. This document states the model, names the disagreements it removes, and
lists the decisions that are the owner's rather than the steward's.

It is a design. Nothing below is claimed to be built; the two sections that say what would judge it are
part of the claim, and no check exists for them yet.

## 1. One record, three projections, one label

A **session** is one append-only log bound to **one folder**, identified by `session-<uuid>`, and
described by the same record read four ways:

| The reading | What it is for | Where it lives now |
|---|---|---|
| **the log** | what happened, in order, and the only thing a run may not rewrite | `src/session/store.ts`, `session.v2.jsonl.zstd` |
| **the surface** | what the model would read *next* — a positional view in which a rewrite shadows a span instead of erasing it | `SurfaceState`, `deriveMessages` |
| **the trajectory** | the same log read structurally: turns, steps and records, as the right panel shows them | `src/server/ledger.ts`, `projectLedger` |
| **the meta record** | the label and the counters a listing needs without decoding a log | `meta.json`, `SessionMeta` |

The rule that makes them one thing rather than four:

> **The log is the record; the surface is what the model reads; the trajectory is the log read
> structurally; the meta record is a cache of the log's own facts. Where any of them disagrees with the
> log, the log is right and the other is stale — except for the surface, which is *defined* to differ
> and must say so.**

That last clause is the whole reason the surface exists: a compaction must change what the model reads
while the record stays intact. The design obligation that follows is not "they must show the same text"
but **"they must never disagree about the difference"**: if the model does not read a span, the
trajectory has to say the span is shadowed, and by what.

## 2. Where they disagree today

Each of these was located in the working tree rather than guessed at. They are the reasons the owner
asked for this.

| The disagreement | Why it happens | Who is right |
|---|---|---|
| A compaction hides a span from the model, while the trajectory and the chat pane still show it as ordinary conversation | the surface folds `context/note` replacements; the trajectory and the chat fold read the **raw log** | the surface, for what the model read; the log, for what happened. Neither view may pretend the other reading does not exist |
| The trajectory renders a compaction as two generic `system` rows (`compaction/summary` and the replacement note), and its declared `'compaction'` record kind is **never emitted** | `projectLedger` has no case for `compaction/*` or `context/note`, so they fall through to the "unknown event type" branch | the trajectory, once it is told what a compaction is |
| `meta.turns` can exceed the number of completed turns | the counter is bumped when the user message is appended, before the model is called, so a turn that is refused or that fails still counts | nobody today — no check compares them, and no event records a turn's start |
| The title is invisible to the log, the trajectory and the chat fold | it lives only in `meta.json`; there is no `session/title` event, and `rename` writes the meta file alone | the meta record, for now — but a trajectory that cannot say what the session is called is the weaker view |
| A resumed session can be given a different folder's instruction baseline | context takes `cwd` from its caller (`sandbox.workspaceRoot`), never from `meta.cwd` | the session's own folder, once the two are tied — the folder is the session's identity |
| The trajectory has no folder and no identity at all | `LedgerEvent` declares no id, cwd or title, and `session/created` (the one event carrying `cwd`) is skipped by the projection | the log, which recorded the cwd in its first event |
| Two rules for "the folder's current session" | the service takes the newest by list order; the tree re-derives it from `meta.created` | one rule, in one place |
| Records before the first turn are in `records` but absent from the timeline, and no check pins it | `projectTimeline` walks turns only | the model should decide; the current split is accidental |

## 3. The alignment

Four moves, in order. Each is small; together they are what "lined up" means.

**3.1 A turn becomes a recorded fact, not an inference.**

The log gains `turn/start` (with the turn's index and what the request was for) and `turn/end` (with
the outcome: `completed`, `refused`, `failed`). The trajectory then *reads* turns instead of inferring
them from "a user message opens a turn, and the next one or `turn/completed` closes it", and the two
questions a person asks — *how many turns did this session have* and *how many finished* — get two
recorded answers rather than one counter and one count that disagree.

`meta.turns` becomes a **cache of `turn/start`**, refreshed from the log when the log is read, and the
counter gains its second value (`turnsCompleted`). A listing stays cheap; the number stops being a
second opinion.

**3.2 Every projection carries the session's identity and folder.**

`session/created` already records `cwd`; the trajectory stops skipping it and uses it as the horizon of
the session — the folder it is bound to, shown on its own axis. `ContextReport` gains
`{ session, cwd }`, and context resolves its instruction root from the **session's folder**, so a
session resumed somewhere else is told plainly that it is being read against the folder it belongs to
rather than silently given a different `AGENTS.md`.

One rule for "the folder's current session" lives in the session service and the tree calls it. The tree
is a view; it does not get its own opinion about which conversation a folder holds.

**3.3 The trajectory projects the surface, and shows the shadow.**

The trajectory is not a second chat pane: it is the structural reading, and the structure a person most
needs to see is **what the model actually read**. So the projection takes surface positions as its
backbone and marks each record with how the surface treats it:

- a record the model reads: an ordinary row;
- a record a rewrite shadowed: rendered as **shadowed**, with the seq of the replacement that shadows it
  and the replacement's own row in place of the span it covers;
- a `compaction` becomes the declared `'compaction'` kind it already names but never emits — one row for
  the transaction, saying which positions it replaced and how many tokens it saved.

The chat pane keeps reading the **log**, because a person wants to see what was said. The two panes then
differ on purpose, and each says which reading it is — the one place the design allows disagreement, and
only because it is the *point* of the surface.

**3.5 The log stays local, and the session's definition is tracked content.**

The owner's ruling of 2026-10-11, and it settles what the rest of this document only implied:

| The fact | Where it lives | Tracked? |
|---|---|---|
| the **log** — every event, in order | `~/.heddle/sessions/<workspace>/<session-id>.jsonl` | no, it is machine state |
| the **session definition** — the log it references, how to compose its context, which tools it may use, its endpoint and preset | `<target folder>/<…>/<instance>/_sessions_/<session>/` | **yes, committed to GitHub** |
| the **label** a person reads | the session's own `_sessions_` instance, with `meta.json` as the local cache | yes, in the instance |

So a session is not one file but a **pair**: a bulky append-only log kept out of the repository, and a
small tracked instance that says *which* log it is and *how* to run it. That is a better split than either
extreme — a log in the repository would put every token a model ever read into git history, and a session
with no tracked definition could not be reviewed, diffed or pointed at by a folder.

`_sessions_` is a registered type in the reflection vocabulary as of the same day, so the instance follows
the conventions like any other: a kebab-case instance folder, its own `INDEX.md`, and the metadata the
harness reads beside it. Two things it settles and two it leaves open:

- **Settled: the tree and the store now have one anchor each, and they meet at the instance.** The tree
  finds a session because `<instance>/_sessions_/<session>/` exists; the store finds one because its log
  exists. A session whose folder was deleted is a log with no definition; a session whose log was deleted is
  a definition with no transcript, and both are states a view can report rather than guess at.
- **Settled: the folder is the session's identity in the repository.** `meta.cwd` stops being the only
  place the binding is written down, and the instruction root (§3.2) becomes the folder the instance sits in.
- **Decided: a session instance is called `session-<yyyymmdd>-<hhmm>`**, with an ordinal when that minute
  is already taken. It is three words, so it is a valid instance name; it sorts chronologically, so the
  newest session of a branch is the last one a listing shows; and it comes from the clock rather than from
  the first prompt, because a session is created before it has one. The id stays the identity.
- **Decided: the metadata is two files** — `INDEX.md` for the reader, `session.json` for the harness
  (the log's path, the bound folder, the endpoint, the model, the title). An entry point is prose and a
  harness needs fields, so one file could not be both.

**3.4 A title is a fact about the session, and the log is where facts live.**

`session/title` becomes a log event, latest wins, appended by `rename`, and `meta.title` becomes the
cache that a listing reads. The trajectory can then label its own axis, the tree can label a row from the
same fact, and a title change is visible as an event rather than as a silent rewrite of a file beside the
log.

## 4. What judges it

The alignment is judged where its pieces already are, plus one new check that exists for exactly this:
whether the four readings tell one story.

| The claim | Judged by |
|---|---|
| the log is append-only, a torn tail is repaired, and a repair is recorded | [`_verifiers_/70-workspaces-sessions/`](_verifiers_/70-workspaces-sessions/INDEX.md) |
| context is assembled from the surface, priced, pruned and compacted within a budget | [`_verifiers_/30-context-management/`](_verifiers_/30-context-management/INDEX.md) |
| the trajectory is a projection of the recorded events, with turns, steps and records | [`_verifiers_/85-trajectory-view/`](_verifiers_/85-trajectory-view/INDEX.md) |
| **the four readings agree** — a turn that was refused is one turn in meta and one in the trajectory; a shadowed span is absent from `heddle context`, marked in the trajectory and present in the chat; the session's folder is the instruction root; a rename is an event and a label at once | **unnamed part 7 checks and part 3 checks, extended — see below** |

The checks that would be added or changed, stated before they are written:

1. *a refused turn is one turn, and it says it did not finish* — `meta.turns` equals the recorded
   `turn/start` count, `turnsCompleted` equals the `turn/end` count with `completed`, and the trajectory
   shows the turn once, marked refused.
2. *a compaction is one row, and the span it shadows is marked rather than shown* — after a compaction,
   the trajectory carries exactly one `compaction` record naming the replaced positions, the chat still
   shows the shadowed turns, and `heddle context` does not.
3. *a session's folder is the instruction root* — resume a session from a different directory and the
   baseline read is the session's own folder's, not the caller's.
4. *a rename is recorded and visible* — a `session/title` event is appended, the listing shows it, and
   the trajectory's axis label uses it.
5. *one rule decides a folder's current session* — the tree and the service answer the same id for the
   same folder, whatever the order the store happens to list in.

## 5. Decisions that are the owner's

These are the choices this design cannot make for the owner, each with the recommendation and what it
costs.

1. **Does a refused turn count as a turn?** Recommended: yes — it happened, and the trajectory shows it
   marked as unfinished, while `meta.turnsCompleted` says how many finished. The alternative (count only
   completed turns) makes the counter disagree with the record, which is the state this document exists
   to remove.
2. **Does the trajectory show the surface or the log?** Recommended: the surface, because that is the
   reading no other pane gives, and the shadow is the thing that is invisible today. Cost: the trajectory
   and the chat pane will differ, deliberately and visibly, which needs the panes to say which reading
   they are.
3. **Is the title a log event or a meta-only field?** Recommended: a log event with meta as its cache —
   one fact, one home, and the trajectory gets an axis label. Cost: one more event type, and a rename
   writes both.
4. **Does the log gain `turn/start` and `turn/end`?** Recommended: yes. Cost: the format version moves
   again, and old logs are read by inference exactly as they are today (the format catalog already
   exists for that).

## 6. What this document does not decide

- **How a turn's start is priced.** The request's tokens, window and budget are a context question and
  are already answered by `ContextReport`; this document only says the trajectory may show them.
- **Multiple sessions per folder.** The tree's rule is one folder, one session (see
  [`SESSION_TREE.md`](SESSION_TREE.md)); this document keeps that rule and says nothing about a second
  conversation in the same folder beyond "it is in the store and not in the tree".
- **The document viewer.** The `docs` and `file` routes read files under a root and are not projections
  of a session; nothing here lines them up with anything, and they are not claimed to be.
