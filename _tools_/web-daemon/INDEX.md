---
title: Web Daemon
version: 1.0.0
description: The launchd agent that keeps the heddle Web UI running at the documented port.
grounded_in:
  - source: owner statement in the dsh session, 2026-10-11, asking for a daemon on 3082
---

# `web-daemon`

Holds the definition that makes the Web UI a **service** rather than a command someone runs: a launchd
agent template, an installer that fills it in for the machine it runs on, and the liveness decision a
supervisor needs.

## What belongs in it

| File | What it is |
|---|---|
| [`heddle-web.plist.template`](heddle-web.plist.template) | the agent, with placeholders for the node binary, the checkout and the port |
| [`install.sh`](install.sh) | writes the agent for this machine and loads it; `--status`, `--restart`, `--uninstall` |

## Why an agent and not a daemon

The convention is explicit: a **LaunchDaemon** is boot-level and needs root, a **LaunchAgent** needs no
privileges and starts at login. `~/Library/LaunchAgents` is owned by the account the service runs as, so
installing, inspecting and removing this needs no `sudo` — and a file the operator can read is worth more
than a unit they have to be told about.

## What keeps it up, and how that is judged

`KeepAlive` is the supervisor half of the convention, with `ThrottleInterval` bounding a crash loop, and
the working directory is what makes the default profile load — a daemon started elsewhere would boot an
empty tree, which is a real failure mode this repository has already met once.

**Liveness is port ownership**, never a process-name search. The convention is blunt about why: `pgrep -f`
matches the searching command's own line and has been measured concluding a dead service was up. A bound
port cannot be satisfied by our own argv and cannot be satisfied twice, and because the server is the
agent's only process there are no children to orphan.

The server answers `GET /healthz` with its own name and port and **nothing else** — no counts, no
version, no session data — which is the one route reachable without a token, so it is the one route that
must say nothing worth having. The definition and the server therefore agree on a single endpoint instead
of on parsing a banner.

## How the token works here

The launch token is minted **per process** and never stored, which does not change because the process is
supervised: each restart prints a new one into the log. The installer says so and gives the command that
reads the last one, rather than printing a URL whose token would be stale by the time it was used.

## Read next

[`../../_verifiers_/95-web-daemon/INDEX.md`](../../_verifiers_/95-web-daemon/INDEX.md) for the claim this
decides, and [`../../src/server/INDEX.md`](../../src/server/INDEX.md) for the server it runs.
