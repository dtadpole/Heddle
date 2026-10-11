---
title: Verifiers
version: 2.3.0
description: The ultimate verifications — one folder each, named after the capability the owner named, every one keeping the project's 0/1/3 verdict contract.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, listing the ten verifiers
  - source: ULTIMATE_GOAL.md table of parts
---

# `_verifiers_`

Instance of the `_verifiers_` type. **One folder per verification**, named after the capability
the owner stated rather than after the layer that happens to decide it. Each is a thin entry point over
the check files beside it, and each check file states in its own header what it judges and what it
deliberately does not.

| # | Folder | The claim |
|---|---|---|
| 0 | [`05-config-system/`](05-config-system/INDEX.md) | a run composes its tree from profiles and layers, resolves environment references, and fails loudly |
| 1 | [`10-llm-backends/`](10-llm-backends/INDEX.md) | heddle connects to backend model servers and runs agent loops over them |
| 2 | [`20-streaming/`](20-streaming/INDEX.md) | streaming text and reasoning arrive as separate deltas, with no Web UI involved |
| 3 | [`30-context-management/`](30-context-management/INDEX.md) | context and prompt are composed with retention, a budget and compaction |
| 4 | [`40-pluggable-tools/`](40-pluggable-tools/INDEX.md) | tools are configurable and pluggable |
| 5 | [`50-agentic-loop/`](50-agentic-loop/INDEX.md) | the agentic loop runs with tool calls |
| 6 | [`60-hooks/`](60-hooks/INDEX.md) | hooks intercept a model or a tool call |
| 7 | [`70-workspaces-sessions/`](70-workspaces-sessions/INDEX.md) | a workspace names a target folder, sessions are bound to folders under it, and those folders form a recursive tree |
| 8 | [`75-permission-sandbox/`](75-permission-sandbox/INDEX.md) | a permission sandbox distinguishes read-only, workspace write and full access |
| 9 | [`80-web-ui/`](80-web-ui/INDEX.md) | a Web UI on localhost, on a documented default port, carrying the live stream |
| 10 | [`90-web-ui-token/`](90-web-ui-token/INDEX.md) | the Web UI and its event stream are protected by a token |
| 11 | [`95-web-daemon/`](95-web-daemon/INDEX.md) | a launchd agent keeps the Web UI running at the documented port |

## Where each stands, 2026-10-11

**88 checks, 0 failures, 14 unjudged**, measured by running every verifier. The fourteen are part 7's
tree checks, written ahead of the mechanism they judge because the owner asked for the checks first, and
that is why part 7 reads `3` rather than `0` — an unjudged claim is not a passing one. The checks
otherwise allowed to report unjudged are part 1's real-backend probe, when the machine has no reachable
endpoint configured, and part 12's daemon check, when no agent is installed.

Two things about that measurement are worth stating. It was taken while **another session was working in
the same checkout**, so the counts moved underneath it: part 3 has since grown to eight checks and part 10 to
ten since the previous run, and `85-trajectory-view` appeared as a folder with an entry point and no
check file yet — it therefore has no row in the table below and nothing in it is judged, which the walk
over `_verifiers_/*/verify.sh` reports as a missing entry point rather than as a pass. And the numbers
are counts of checks, not of parts.

| # | Checks | Verdict |
|---|---|---|
| 0 | 10 | `0` — profiles, layers, includes, references, validation, provenance |
| 1 | 6 | `0` — both wire shapes, the configured default, listing costs nothing, one real endpoint |
| 2 | 5 | `0` — deltas before completion, with no browser, on every turn of a resumed session |
| 3 | 8 | `0` — the surface and its shadowing, the endpoint's window, prune-before-summarise, a balanced cut, a refused summary, overflow recovery, the instruction baseline, and compacting a long conversation more than once |
| 4 | 6 | `0` — allow list, an out-of-repository tool, a replacement, a malformed spec refused |
| 5 | 6 | `0` — multi-round tasks, results fed back, the limit reported, resume, a failed tool |
| 6 | 6 | `0` — the hook points, retarget, refusal, replacement, a refusal that stops, a broken hook named |
| 7 | 19 | `3` — five pass; fourteen unjudged, judging the folder-bound tree: containment, the nearest root, one session per folder, classification, badges, laziness |
| 8 | 5 | `0` — the three modes, the sibling prefix, and the temp directory only when admitted |
| 9 | 4 | `0` — port, page, API, and the live stream |
| 10 | 10 | `0` — fresh token, cookie handshake, the fence, both endpoints refused, the secret's mode, a stale token's recovery page, session history over the API and in a browser |
| 11 | 3 | `0` — a complete definition, the port answering with the service's name, and a kill it recovers from |

## The verdict contract

Every entry point returns `0` when its claim holds, `1` when it fails, and `3` when it could not be
judged — and a claim that cannot be judged is never reported as holding. The runner that enforces this
is [`_tools_/verify-runner/`](../_tools_/verify-runner/INDEX.md), because `node --test` alone cannot: measured, a suite
where every check is skipped exits `0`, which is the one answer that must never be given for "nothing
was judged".

A folder with more than one check file runs each and keeps the worst verdict, with failure outranking
unjudged. That ordering is deliberate: a broken capability matters more than a missing one.

## What each check may spend

**Nothing, by default.** A check drives a *scripted* endpoint — a JSON file of steps the `scripted`
adapter replays, calling nothing — or a local HTTP double that speaks the provider's real wire shape.
Both are offline by construction, so a check is reproducible and free.

The one exception is inside part 1: a check named for the real backend asks a **configured** endpoint for
one short answer. It reports unjudged when no endpoint is configured or the signer is not running, because
"the gateway was not set up" must never be recorded as "the gateway works".

## Where the code lives, and which code does not

| The claim | Where the assertion lives |
|---|---|
| a wire shape is parsed correctly | the claim's own check, against a local double that streams that shape |
| an endpoint is reachable and configured | the claim's own check, against the machine's own configuration |
| the harness behaves as the goal describes | the claim's own check, driving the built CLI |
| the framework's own primitives — a context, a fiber, an inject gate | [`test/`](../test/), the project's unit suite, which the goal's checks assume rather than re-test |

The line is drawn by **what is being judged**: a claim about the delivered harness belongs here, a claim
about a Cordis primitive belongs in the unit suite. A verifier that re-tested Cordis would be testing a
dependency, and one that tested nothing but its own fixture would be testing the fixture.

## Read next

[`ULTIMATE_GOAL.md`](../ULTIMATE_GOAL.md) for the parts these ten decide, and each folder's `INDEX.md`
for what its claim judges and what it deliberately does not.
