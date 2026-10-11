# heveld

A harness and agent framework built on [Cordis](https://github.com/cordiverse/cordis), in TypeScript.

**The name.** *heveld* is the Middle English spelling of *heddle* — the part of a loom that raises the
selected warp threads so the shuttle can pass. The lineage is `hefeld` (Old English) → `heveld`
(Middle English) → `heald` / `heddle` (modern); `heveld` is the stage whose spelling agrees with how
the word is said, `HEV-eld`. The bare npm name is free.

**Status: a scaffold, not a harness.** What exists is the frame the rest hangs on — a root context, one
service, one consumer of it, a console exporter, and tests that pin the framework's behaviour. Tools,
sessions, models, sandboxing and the config-driven plugin tree are all still to come.

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
  cli.ts                     the `heveld` command
  events.ts                  the events Heveld's plugins may emit
  index.ts                   the public surface
  plugins/
    greeting.ts              a service: config, lifecycle, `greet()`
    announce.ts              a consumer: inject-gated, listens for `heveld/ready`
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
