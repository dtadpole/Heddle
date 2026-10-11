---
title: Heddle Ultimate Goal
level: L2
version: 1.0.0
description: What completes this project — the six capabilities that separate a harness from a scaffold, each judged by a runnable verifier in _verifiers_.
status: unverified
grounded_in:
  - source: README.md section Roadmap and section Status
  - source: owner statement in the dsh session, 2026-10-11, that the goal is the complete harness
goal_state: pursuing
as_of: 2026-10-11
evidence: _verifiers_ baseline run recorded in _verifiers_/INDEX.md
---

# Ultimate Goal

**This project is complete when Heddle is a harness rather than a scaffold** — a run of it loads its
plugins from a configuration file, holds a session across turns, talks to a model through a service,
lets that model act through registered tools, refuses what the sandbox and the approval policy forbid,
and records the whole run so that it can be resumed and read.

The `README.md` is the source of this statement, and it says the same thing in the negative: *"Status: a
scaffold, not a harness. What exists is the frame the rest hangs on… Tools, sessions, models, sandboxing
and the config-driven plugin tree are all still to come."* The six parts below are those five plus the
end-to-end run that proves them together. Nothing here is invented beyond that list; the parts were
mapped from it rather than chosen.

| Part | Satisfied when | Decided by |
|---|---|---|
| configuration-driven | a run loads its plugin tree from a configuration file — no code edit, no plugin imported by name in source — and the loaded set is exactly the declared set | [`_verifiers_/10-config-driven/`](_verifiers_/10-config-driven/INDEX.md) |
| session | a session survives a process exit as a readable record on disk, and a resumed session carries the earlier turns rather than starting blank | [`_verifiers_/20-session/`](_verifiers_/20-session/INDEX.md) |
| model | a model service is injectable through Cordis and completes a decision without any production credential, because the provider it talks to is substitutable | [`_verifiers_/30-model-service/`](_verifiers_/30-model-service/INDEX.md) |
| tools | tools and commands are registered as services rather than imported, are discoverable with a description, and a call produces its side effect | [`_verifiers_/40-tools/`](_verifiers_/40-tools/INDEX.md) |
| sandbox | a sandbox and an approval policy exist and are demonstrated by refusal — a forbidden action is denied and is observable as denied | [`_verifiers_/50-sandbox-approval/`](_verifiers_/50-sandbox-approval/INDEX.md) |
| end to end | one run, from configuration, completes a multi-step task that uses a tool, records it, and is resumed from that record | [`_verifiers_/60-end-to-end/`](_verifiers_/60-end-to-end/INDEX.md) |

## What the target is not

- **Not a product with users.** Distribution is where the parts are verified from — a published package
  is how the end-to-end claim is judged — but adoption is not a part, and no verifier counts it.
- **Not model quality.** Nothing here judges how well a model reasons. The model part asks whether a
  model can be reached through the framework at all, and its tests deliberately run against a scripted
  provider instead of a real one.
- **Not a catalogue of tools.** Four tools and one command satisfy the tools part if they are truly
  registered rather than imported. Coverage is not the claim; the extension point is.
- **Not DSH's feature set.** DSH is the model for how the pieces fit, not a specification to exceed. A
  capability Heddle has and DSH does not is welcome and is not required.

## The constraint that is part of the goal

**Every verifier runs offline and spends nothing.** No API key, no network call to a model, no quota. A
part that could only be judged by spending the owner's credentials is judged by a test double instead,
and its test file says where the double ends. This is the constraint the whole set is built on, because
a check the owner is unwilling to run on a whim is a check that stops being run at all.

## Status

`goal_state: pursuing`, as of `2026-10-11`. This file was **derived by an agent** from the project's own
README and the owner's statement, so it carries `status: unverified` and the owner has not ratified its
wording. Correcting the statement is the owner's act; correcting the *state* is the steward's, from
evidence.

**The baseline is honest and mostly unjudged.** The scaffold passes the four behaviour tests it already
shipped, and every one of the six parts above is either unjudged (exit `3`) or, where a mechanism exists,
only partly judged. That is the expected shape on the day a verifier set is written for a goal that is
not yet reached, and it is why the set distinguishes *unjudged* from *failed*: the number that matters
is how many parts are still unjudged.

**No part is blocked.** Every part depends on work in this repository rather than on something outside
it, so the next move is a session with an objective, not a decision. The only dependency the project
cannot supply for itself is the owner's judgement on a name already in use by another agent runtime, and
that affects distribution rather than any part here.

## How the state is maintained

The `goal_state` above is a **cache of the last transition, and the ledger wins**. Every transition is an
entry in the runtime ledger, written when it happens; if this field and the ledger disagree, the ledger
is right and this field is stale. The values are `pursuing`, `delegated`, `blocked` and `complete`.

The steward reads this file every tick, may move the state between `pursuing`, `delegated` and `blocked`,
and **may not declare `complete`** — completion is an assertion about the world rather than an
observation, and it is the owner's to make.

## Read next

[`_verifiers_/INDEX.md`](_verifiers_/INDEX.md) for the six verifiers, what each judges and what the last
run found; [`README.md`](README.md) for what the project is today and its roadmap;
[`_tools_/runner/INDEX.md`](_tools_/runner/INDEX.md) for the exit contract every verifier keeps.
