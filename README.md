---
title: heddle
version: 0.2.0
description: A harness and agent framework built on Cordis, in TypeScript, with ten verifiers deciding what completes it.
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

**Status: a scaffold, not a harness.** What exists is the frame the rest hangs on — a root context, one
service, one consumer of it, a console exporter, and tests that pin the framework's behaviour. Tools,
sessions, models, sandboxing and the config-driven plugin tree are all still to come.

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
  app.ts                     createApp(): root context plus the plugins
  cli.ts                     the `heddle` command
  events.ts                  the events Heddle's plugins may emit
  index.ts                   the public surface
  plugins/
    greeting.ts              a service: config, lifecycle, `greet()`
    announce.ts              a consumer: inject-gated, listens for `heddle/ready`
    console-exporter.ts      sends the built-in logger to the terminal
test/
  boot.test.ts               what the framework is expected to guarantee
```

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

- [ ] the loader: `cordis.yml` plus `@deepseek-ai/cordis-plugin-loader`, so the tree is configuration
- [ ] an LLM service and a session model
- [ ] tools and commands as services, registered rather than imported
- [ ] a sandbox and approval policy
- [ ] one real end-to-end run, recorded as a test

## License

MIT © D.Tadpole. See [LICENSE](LICENSE).
