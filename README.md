---
title: heddle
version: 0.3.0
description: A harness and agent framework built on Cordis, in TypeScript, with eleven verifiers deciding what completes it.
level: L2
status: unverified
grounded_in:
  - source: human-authored
---

# heddle

A harness and agent framework built on [Cordis](https://github.com/cordiverse/cordis), in TypeScript.

**The name.** A *heddle* is the part of a loom that raises the selected warp threads so the shuttle can
pass — the piece a harness is made of. The lineage is `hefeld` (Old English) → `heveld` (Middle
English) → `heald` / `heddle` (modern); this project takes the modern word, the one a weaver
recognises. Its bare npm name belongs to an unrelated package, so releases go out under the owner's
scope as **`@dtadpole/heddle`** while the command stays `heddle`.

**Status: a harness, and a small one.** It loads its plugin tree from configuration, talks to real
model backends and streams their reasoning and answers as they arrive, keeps sessions as append-only
event logs grouped under workspaces, runs an agentic loop over registered tools, composes its context
with a token budget and compaction, offers hook points around a model and a tool call, confines file
effects with a permission sandbox, and serves a token-protected Web UI on localhost. What completes it
is stated part by part in [`ULTIMATE_GOAL.md`](ULTIMATE_GOAL.md), and decided by
[`_verifiers_/`](_verifiers_/INDEX.md) — sixty-six checks, all passing.

## The Web UI

```bash
heddle web                 # serves http://127.0.0.1:3082/ and prints the URL, token included
heddle web --port 0        # an ephemeral port, for a check or a second instance
```

The default port is **3082** — 3080 is DSH's, and the two run side by side on this machine.
The server binds loopback and refuses any other host, because a harness that runs tools is
remote code execution behind a token. The printed URL carries a per-process token; opening it
exchanges that token for a cookie, and the page then streams the session live, reasoning and
content as they arrive. See [`_verifiers_/80-web-ui/`](_verifiers_/80-web-ui/INDEX.md) and
[`_verifiers_/90-web-ui-token/`](_verifiers_/90-web-ui-token/INDEX.md) for what is checked.

## Quick start

```bash
npm install
npm start                 # boots the app and prints the loaded plugin tree
npm start -- -t world -p '?'   # boots with other config
npm test                  # node's test runner over test/*.test.ts
npm run check             # type-check source and tests, no emit
npm run build             # emit dist/ (JavaScript plus declarations)
```

`node src/cli.ts` works directly: Node 24 strips TypeScript types, and this project is written in
erasable syntax only so nothing needs a loader.

## Layout

```
src/
  boot.ts                    composes the layers and starts the tree
  cli.ts                     the `heddle` command
  config/                    profiles, layers, includes, references, validation, provenance
  agent/loop.ts              one turn: context, model, tools, recorded as it happens
  llm/                       the model service, its wire adapters, and the HTTP client
  context/                   assembly order, the token budget, pruning, compaction
  session/                   the append-only event log and its service
  workspace/                 workspaces as folders with records, sessions under them
  sandbox/                   where a file effect may land, by mode
  approvals/                 whether an action may be taken at all
  tools/                     the tool registry and the tools this project ships
  server/                    the Web UI and its token
  stream/                    the live view on a terminal, from the same events
  plugins/                   the Cordis plugins a profile names
_context_/                   how DSH implements each mechanism this one mirrors
_tools_/                     the verifier runner and the check helpers
_verifiers_/                 the eleven verifications, one folder each
test/                        the framework's own unit suite
```

Every folder carries an `INDEX.md`; [`AGENTS.md`](AGENTS.md) is the entry point for whoever works
here.

## The Cordis rules this code follows

1. **`ctx` is a proxy.** `ctx.greeting` is a service lookup, not a property read, so a plugin must
   declare `inject` before it may read one.
2. **Every effect is owned.** Listeners, services and exporters are registered against the current
   fiber and are released when it unloads — nothing needs a global teardown list.
3. **`inject` is a gate, not an ordering.** A plugin that injects a service which does not exist yet
   stays `pending`, and its body has not run. If the service disappears, it unloads and waits again.
4. **Config is validated first.** A plugin's `Config` schema runs before its body; a bad value is a
   load error, not a surprise later.
5. **Behaviour belongs on `internal/*` events** when it extends the framework itself; see
   `cordis/src/events.ts` for the set.

## Roadmap

What is left is not a list of mechanisms — those are built and judged. It is what a harness needs
once one person uses it daily:

- [ ] **the published package**: `@dtadpole/heddle@0.0.1` exists; a release after this work does not
- [ ] **a browser check**: the Web UI is judged over HTTP, not by a browser
- [ ] **compaction that scales**: the summary is one model call; a long project will want a policy
- [ ] **more than one workspace root**: workspaces are discovered from session directories today
- [ ] **README-driven onboarding**: what a second person needs that this one supplies from memory

## License

MIT © D.Tadpole. See [LICENSE](LICENSE).
