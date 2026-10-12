---
title: Sessions
version: 1.0.0
description: One instance per agentic session of this branch — the log it references, and how it is run.
grounded_in:
  - source: heddle session definitions
---

# `_sessions_`

Type folder. One instance per session of the branch it sits in, written by heddle when a session is started
there. An instance names the **log** it references and how the session is run; the transcript itself is
machine state and lives outside this repository, under `~/.heddle/sessions`.

The tree does not draw this folder. It shows each session directly under the branch, first, because the
folder is a filing decision rather than something to navigate — and the branch is what a person is looking
for, not the drawer the session is kept in.
