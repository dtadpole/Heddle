---
title: DSH Hooks
level: L2
version: 1.0.0
description: What a hook is in DSH — the event points, their dispatch modes, and how a listener is owned.
status: unverified
grounded_in:
  - source: the installed DSH packages under ~/.volta, read on 2026-10-11
  - source: the live store at ~/.dsh for the workspace and session shapes
---

# DSH "Hooks" — Implementation Report

`$P` = the installed package root `…/dsh/node_modules/@deepseek-ai/`; every relative path below is under it.

## 1. Does DSH have a named "hook" concept?

Yes — but two distinct things carry the name, and conflating them is the main trap.

**(A) The named hook subsystem (external command hooks):** `dsh-hook-protocol`, `dsh-hooks-claude-code`, `dsh-hooks-codex`. A "hook" here is an **external shell command** from a Claude Code / Codex `hooks.json`, run at a named *hook point* (`PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`, `SubagentStart`/`Stop`) with a JSON payload on stdin.
- `dsh-hook-protocol/lib/types/types.d.ts`: `HookDialect = 'claude-code' | 'codex'`, `CommandHook` (`{command, timeoutSec?}`), `MatcherGroup` (`{matcher?, hooks: CommandHook[]}`), `HookOutput` (exit-code + stdout-JSON: `continue`, `decision: 'approve'|'allow'|'block'|'deny'|'ask'`, `additionalContext`, `updatedInput`, …).
- `runner.d.ts`: `runHook(bash, hook, options, now)`, `DEFAULT_HOOK_TIMEOUT_MS = 600000`. `events.d.ts`: `appendHookInvoked` / `appendHookResult` — log-only session events `hook/invoked` / `hook/result` on `SessionEventMap` (not Cordis `Events`; no `surfaceOp`). `merge.d.ts` `mergeHookOutputs` → most-restrictive fold `deny > ask > allow`.

**(B) The mechanism (A) is built on — Cordis events.** There is no separate DSH hook API: a native hook *is* an event listener. Cordis names the record `Hook` (`cordis/lib/types/events.d.ts:108`: `interface Hook extends EventOptions { ctx; callback }`), stored in `EventsService._hooks` and per-fiber as `Fiber._hooks` (`fiber.d.ts:117`). The `dsh-hooks-*` packages are **bridges**: config file → `MatcherGroup[]` → `runHook` → `ctx.on(<event>, …)` listeners mapping `HookOutput` onto the event's typed Decision. There is no `dsh-agent-hooks`; that role is played by typed listeners in `dsh-agent` / `dsh-agent-loop` / `dsh-agent-instructions`.

## 2. Hook points around a model call and a tool call

Cordis `DispatchMode` (`cordis/lib/types/events.d.ts:25`): `emit` (sync, returns ignored), `parallel` (await all), `serial` (await in order, stop on first bail), `bail` (sync, stop on first bail), `waterfall` (listener wraps a final `next`; **not calling `next()` vetoes the rest of the chain including the built-in behaviour**, `cordis/lib/index.js:317`). `isBailed(v)` is true unless `v` is `null`/`false`/`undefined`.

### Model call

| Event | Mode | Declared at | Listener can |
|---|---|---|---|
| `agent/pre-step` | waterfall | `dsh-agent/lib/types/runtime-types.d.ts:313` | reject the step (`{kind:'reject'}`) or replace `messages`; inject context |
| `agent/request` | waterfall | `:336` | `await next()` → default `LlmCallConfig`; **return a replacement** (provider/model/effort/maxTokens). Returning without `next()` fully overrides |
| `agent/request-error` | waterfall | `:357` | claim recovery: return `{kind:'retry'}` without `next()`, else `next()` |
| `llm/stream` | waterfall | `dsh-llm/lib/types/index.d.ts:45` | around **every** streaming call: `next()` → adapter stream, or **yield your own `AsyncIterable<StreamChunk>` to short-circuit**. Loop-built `GenerateOptions` is deep-frozen: read-only |
| `agent/assistant-stream` | emit | `runtime-types.d.ts:375` | observe `start`/`chunk`/`end` frames only |
| `agent/turn-stopping` | serial | `:396` | observe / `steer()`; a bail value short-circuits the serial chain |

Dispatch sites (`dsh-agent-loop/lib/index.js`): `:894` pre-step, `:1143` `agent/request` (built-in `next` = `() => Promise.resolve(seedConfig)`), `:1088` request-error, `:967` turn-stopping. `agent/request` runs after assembly and `step/start`, before the system prompt + accepted batch commit.

### Tool call

| Event | Mode | Declared at | Listener can |
|---|---|---|---|
| `tools/pre-execute` | waterfall | `dsh-tools/lib/types/index.d.ts:38` | `PreToolDecision` (`:419`): `{kind:'allow'} \| {kind:'deny',reason} \| {kind:'ask',reason?}`. `next()` = allow; `ask` without approval support denies. **No argument rewrite** (args already logged) |
| `tools/execute` | waterfall | `:49` | around-dispatch wrapper (timeout/retry/metrics). `next()` → normalized result. Wrappers may change **only `exec.signal`**; identity immutable, registry re-fuses the caller signal |
| `tools/post-execute` | waterfall | `:61` | `PostToolDecision` (`:432`): `accept` (optionally replace `content` **or** `value`) / `block` (`feedback` + `additionalContexts`) |
| `tools/ptc-dispatch-log` | waterfall | `:75` | replace the **durable-log copy** of one `run_code` sub-dispatch; model never sees it |
| `tools/result` | emit | `:83` | observe the frozen lossless-JSON final outcome; failures contained |
| `tools/change` | emit | `:93` | registry-subject notification (unfiltered), no payload |

Non-event veto paths (not hooks): `ToolGuard` (`index.d.ts:489`, after all `pre-execute` listeners) and `ToolDefinition.finalizeContent` (`:131`, snapshotted once per execution).

## 3. Registration and ownership (fiber-scoped, auto-released)

`const dispose = ctx.on('tools/pre-execute', async (exec, next) => {…}, {prepend?, global?})`. `EventsService.on` (`cordis/lib/index.js:374`) → `assertActive()` → `bail('internal/listener', …)` (a bail listener may replace registration) → `register(label, hooks, callback, options)` (`:335`) → `this.ctx.fiber.effect(() => { hooks.push/unshift(record); return () => this.unregister(hooks, cb) }, label)`.

So **every listener is an effect of the registering fiber.** `Fiber._unload()` (`cordis/lib/index.js:1370`) drains `_disposables` in reverse registration order, so unloading or `dispose()`-ing the plugin fiber removes its listeners; the returned disposer is idempotent. Registering on a disposed fiber throws `CordisError('INACTIVE_EFFECT')`; `ctx.once` unregisters after the first call. Ordering: `prepend:true` (or a bare `true` third arg) makes a listener **outermost** in a waterfall — first-registered is outermost, last-registered sits closest to the built-in `next`.

Scoping: agent/tool events dispatch with a `Scoped<T>` `this` (`Scoped<Agent>`, `Scoped<ToolRuntime>` — `dsh-scope`), and `EventsService.dispatch` filters via `thisArg[Context.filter](hook.ctx)`, so an agent-scoped listener only sees its own agent's calls. `{global: true}` opts out.

## 4. User-editable files vs code-only

**(a) Plugin config — user-editable loader YAML.** A profile's `cordis.yml` is an empty entry list, composed from bundles in `package.json`'s `dsh.profile.bundles`, then `cordis.patch.yml`, then `--patch` overlays (`/Users/zhenc/.dsh/profiles/web/cordis.yml`, `cordis.patch.yml`). Bridge READMEs show:

```yaml
- name: '@deepseek-ai/dsh-hooks-codex'
  config: { configPath: ./.codex/hooks.json, model: deepseek-v4 }
```
Fields: `configPath` (required), `defaultTimeoutMs` (600000), `stderrSummaryMaxChars` (500), `model?`, `pluginRoot?`, `projectDir?`.

**(b) The hook commands themselves — the external `hooks.json`.** `configPath` points at a bare `hooks.json` event map or a settings file whose `hooks` key holds it — `parseClaudeCodeConfig(raw, vars)` (`dsh-hooks-claude-code/lib/types/config.d.ts:49`), `parseCodexConfig(raw)` (`dsh-hooks-codex/.../config.d.ts`). Each event maps to `MatcherGroup[]` = `[{matcher?, hooks: [{type:'command', command, timeoutSec?}]}]`. Claude treats `[A-Za-z0-9_|]+` as literal alternation, else unanchored regex; Codex is always unanchored regex (`matcherDiagnostic` / `matchesMatcher`, `dsh-hook-protocol`). **Read once at load, process-level, no live reload**; a relative path resolves against the launch cwd. Non-command hooks (`prompt`/`agent`/`http`, Codex `async: true`) are parsed-and-skipped with a warning; `updatedInput` is parsed but **not honored** (logged + warned).

**(c) Code-only.** A native listener requires a plugin (`Plugin.Function | Constructor | {apply}`); no user-editable file declares native listeners.

## 5. Cordis loader interception and start gating

Three different things share the word "intercept":

1. **`Context.intercept(name, config)`** (`cordis/lib/types/context.d.ts:96`) — returns a child context carrying an extra entry in `Context[symbols.intercept]` (`service name → config`). Plugins started below it see that config merged into the service's resolved config (ancestor entries first, via `Service[symbols.resolveConfig]`). Service-config interception, unrelated to events.
2. **`Loader.Intercept`** (`cordis-plugin-loader/lib/types/index.d.ts:44`) — the loader's own intercept-config type: `interface Intercept { await?: boolean }` ("keep dependent plugins pending while loader entries are still loading"), bound via `[Service.config]: Loader.Intercept` (`:56`). `Plugin.Base.intercept?: Dict<boolean>` (`registry.d.ts:62`) declares which services' intercept config a plugin consumes.
3. **`inject` — the actual start gate.** `Plugin.Base.inject` / `plugin.inject` / `ctx.inject(deps, cb)` / `@Inject(name, config?)`. `Inject` is `(keyof M)[]` (no config) or `{name: config}` (`registry.d.ts:13`); `Inject.resolve` normalizes class/static metadata to `name → config | null`.

Gating (`cordis/lib/index.js`): on service registration the reflect layer calls `fiber._checkImpl(name)` per injected name (`:1310`) filling `fiber._store`; `_refresh()` (`:1316`) builds an epoch string `":" + impl.fiber.uid` for every injected service, `INACTIVE` if any is missing. `_setEpoch` (`:1327`): `INACTIVE → LOADING` starts `_reload()`, else `UNLOADING`/`DISPOSED` runs `_unload()`. `_reload()` (`:1348`) runs the **`internal/config` waterfall** (`_resolveConfig`, `:1345`: waterfall, then the plugin's `Config` standard-schema validation) and only then executes the plugin body. So a plugin's listeners exist exactly while every injected service is present; losing one unloads the plugin and disposes them, regaining it reloads. Other core/loader interception events: `internal/update` (waterfall; skip `next()` to veto a config update, `fiber.d.ts:199`), `internal/get` / `internal/set` (service proxy), `internal/service`, `internal/listener` (bail), `internal/dispatch`, `internal/plugin`, `internal/status`, plus `loader/config-update`, `loader/entry-init`, `loader/partial-dispose`, `loader/patch-context`.

## 6. Real listeners in the code

1. **`dsh-tool-call-timeout-policy/lib/index.js:116`** — `ctx.on('tools/execute', …)`, `inject = ['tools']`. Reads `ctx.tools.get(exec.name, exec.agent)?.timeoutMs`; absent → `next()`; else swaps `exec.signal` for a deadline signal, `await next()`, restores the upstream signal in `finally`, and returns a `TOOL_TIMEOUT` error result only when its own timer fired.
2. **`dsh-spill-policy/lib/index.js`** — `inject = ['tools']`; a `tools/post-execute` transformer plus a `tools/ptc-dispatch-log` arm. A plain-text final result over `maxInlineBytes` is stored via `ctx.spillStore` and replaced by an accepted result with a head/tail preview + locator; non-text results are untouched and `read` is skipped by the model-facing arm.
3. **`dsh-agent/lib/types/model-selection.js:62`** — `agentCtx.on('agent/request', async (_p, next) => …)`: `const resolved = await next()`, then return a config overriding the inherited `provider`/`model`/`reasoningEffort`. `dsh-webhook/lib/index.js:69` registers the same event for a programmatic selection (guarded on no existing `requestHeader()`).
4. **`dsh-llm/lib/invariant.js:63`** — `ctx.on('llm/stream', (_o, next) => validateStream(next(), fail), {global: true, prepend: true})`: wraps the provider stream and fails when it ends without a terminal finish chunk or leaves an open block. Shows `prepend` (outermost) + `global` (bypass scope filter).
5. **`dsh-hooks-claude-code/lib/index.js:248`** — the CC bridge's `tools/pre-execute` maps the merged hook outcome to `{kind:'deny'}` / `{kind:'ask'}` / `next()`; `:265` `tools/post-execute` maps `deny → block` with feedback; `:232` `agent/pre-step` rejects the prompt on `deny` and appends hook `additionalContext` after `next()`; `:292` `agent/turn-stopping` calls `agent.steer(...)` to force another step. Codex (`dsh-hooks-codex/lib/index.js:196-282`) is the same five points, deny-only. Both use `ctx.effect(() => () => detached.drain(), …)` so detached hook runs drain on fiber unload.

## The minimum hook mechanism to reimplement

- **One event bus, five dispatch modes** — `emit`, `parallel`, `serial`, `bail`, `waterfall` (`isBailed(v) = v != null && v !== false`). `waterfall(name, ...args, next)` composes listeners around the built-in `next`; a listener returning without calling `next()` vetoes. That one primitive yields read (emit), short-circuit (bail/serial), rewrite/replace (waterfall return), and veto (skip `next`).
- **These event points and modes** — model call: `agent/pre-step` (waterfall, reject/replace messages), `agent/request` (waterfall, replace `LlmCallConfig`), `agent/request-error` (waterfall, claim retry), `llm/stream` (waterfall, short-circuit the chunk stream), `agent/assistant-stream` (emit), `agent/turn-stopping` (serial). Tool call: `tools/pre-execute` (waterfall → allow/deny/ask), `tools/execute` (waterfall, signal-only wrapper), `tools/post-execute` (waterfall → accept/replace/block), `tools/result` (emit), `tools/ptc-dispatch-log` (waterfall), `tools/change` (emit).
- **Registration**: `ctx.on(name, listener, {prepend?, global?})`, keyed by event name into a per-event array; a listener is a plain function whose last parameter is `next` for waterfall events.
- **Release**: registration returns a disposer AND is an effect of the registering fiber; fiber unload disposes it in reverse order, and registering on a disposed fiber throws `INACTIVE_EFFECT`.
- **Gating**: a plugin declaring `inject` starts only when all injected services resolve (`_store` + epoch in `_refresh`); losing one unloads the plugin and disposes all its listeners; the `internal/config` waterfall plus standard-schema validation run before the body executes.
- **Optional external-config layer** (the `dsh-hooks-*` bridges): a user-editable `hooks.json` (`MatcherGroup[]` per point) read once at load, executed through the shell with a timeout, decoded from exit code + stdout JSON into a neutral `HookOutput`, folded most-restrictively (`deny > ask > allow`), and mapped onto the typed Decision of the corresponding event.
