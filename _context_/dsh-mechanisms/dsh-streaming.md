---
title: DSH Streaming
level: L2
version: 1.0.0
description: How DSH streams model output — the chunk vocabulary, the assembler, and the browser transport.
status: unverified
grounded_in:
  - source: the installed DSH packages under ~/.volta, read on 2026-10-11
  - source: the live store at ~/.dsh for the workspace and session shapes
---

# DSH model-output streaming: model service → browser
Scope: installed DSH packages at `.../@deepseek-ai/dsh/node_modules/@deepseek-ai/` (compiled
`lib/*.js`, declarations `lib/types/*.d.ts`). Paths below are relative to that directory.

## 0. Pipeline at a glance

```
provider SSE --(dsh-llm-deepseek/translate)--> AsyncIterable<StreamChunk>
  --(ctx.llm.stream, 'llm/stream' waterfall)--> agent-loop AssistantStreamAttempt
      |-- durable: AssistantStreamAccumulator -> session.append('assistant/message'|'assistant/attempt')
      `-- transient: emit 'agent/assistant-stream' {frame}
  --> api-session-controller SessionAssistantStreamAccumulator
  --> Remote stream endpoint 'session/follow' (assistantStream:true)
  --> WebSocket mux '/api/remote.mux' {type:'item',streamId,value}
  --> ClientAssistantStream fold -> 'assistant/live-chunk' -> chat assembler -> 3x rAF -> React
```

## 1. Exact `StreamChunk` shape
`dsh-llm/lib/types/types.d.ts:359-389`, a union discriminated by `type`:
| type | fields |
|---|---|
| `block-start` | `index: number`, `blockType: ContentBlockType` |
| `text-delta` | `index: number`, `text: string` |
| `reasoning-delta` | `index: number`, `text: string` |
| `tool-call-delta` | `index`, `id: ToolCallId`, `name?: string`, `argumentsDelta: string` |
| `block-end` | `index`, `block: ContentBlock` |
| `usage` | `usage: TokenUsage` |
| `finish` | `reason: FinishReason`, `replayState?: ReplayEnvelope` |
Text vs reasoning vs tool calls are **separate delta variants**, not a flag. `index` correlates
interleaved blocks; each block is one `ContentBlock` (`types.d.ts:91-102`):
`text | reasoning | image | file | tool-call | tool-result`.
`TokenUsage` (`types.d.ts:136-150`): disjoint `inputTokens`/`outputTokens`, optional `totalTokens`,
`cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`. `FinishReason` (`types.d.ts:107-125`):
`stop | tool-calls | max-tokens | aborted{failure} | error{failure}`. Contract (`types.d.ts:351-358`):
adapters emit `usage` before terminal `finish` and nothing after; tool arguments stay raw JSON strings.
DeepSeek mapping: `delta.reasoning_content` → `reasoning-delta` (opens the reasoning block lazily; an
empty first delta does not open), `delta.content` → `text-delta`, `delta.tool_calls[]` →
`tool-call-delta` (`dsh-llm-deepseek/lib/index.js:1208-1300`). `block-end`, `usage` and `finish` are
**deferred to the `[DONE]` sentinel** (`index.js:1226-1243`). SSE parsing uses `EventSourceParserStream`
+ `TextDecoderStream` (`index.js:1107-1114`); missing `[DONE]` throws `LlmError('STREAM_CLOSED')`.

## 2. Assembler: chunks → message
`BlockAssembler` — `dsh-llm/lib/types/assembler.js` (API `assembler.d.ts`). State:
`partials: Map<index,{blockType,text,toolCallArguments,toolCallId?,toolCallName?,block?}>` + `order[]`.
- `push()`: `block-start` creates the partial; `text-delta`/`reasoning-delta` append to `partial.text`;
  `tool-call-delta` records id/name and appends `argumentsDelta`; `block-end` sets `partial.block`
  (**first close wins**; later deltas for a closed index are ignored); `usage`/`finish` are stored.
- `ensure()` synthesizes a missing partial, so delta-only protocols without `block-start` work.
- `assemble()` returns `{type:'reasoning', text}` — reasoning is a **first-class block, kept in the
  message**, never dropped or merged into text.
- `blocks()`: under `finish.kind === 'max-tokens'` it drops every `tool-call` block and prunes the
  matching `ReplayEnvelope.blocks` entries, so content and adapter metadata cannot disagree.
- `interruptedBlocks()` (cancellation) keeps only text/reasoning blocks with non-whitespace text; tool
  calls are omitted (retaining one would need a fabricated result). `message(source)` → frozen assistant `Message`.
- Prompt retention: the loop derives history from the log, and DeepSeek `serializeAssistant` re-emits
  reasoning as `reasoning_content` (`dsh-llm-deepseek/lib/index.js:107-123`). Reasoning is thus kept in
  the log **and** sent back to the model, and rendered separately as a Think disclosure
  (`dsh-client-ui-chat/lib/client.js:2871-2890`).
- Durable compaction: `AssistantStreamAccumulator` (`dsh-llm/lib/types/assistant-stream.js`) packs
  consecutive deltas into lossless runs `{type:'text-chunks'|'reasoning-chunks'|'tool-call-chunks',
  time0,index,dt:[],texts:[] (or args:[])}`; `block-start`/`block-end`/`usage`/`finish` stay raw
  `{type:'chunk',time,chunk}`. `expandAssistantStream` reverses it exactly.

## 3. Browser transport: one WebSocket mux, not SSE
- **Streams/events ride a single WebSocket** at `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"`
  (`dsh-api-gateway/lib/types/stream-protocol.d.ts:4`), registered as an HTTP upgrade route behind the
  normal trust/auth rejection (`dsh-api-gateway/lib/index.js:455-475`). The browser builds the URL from
  `location.origin` with `ws:`/`wss:` (`dsh-api-gateway/lib/client.js`, `remoteStreamUrl()` ~541-547).
- **Unary RPC** is HTTP POST JSON under the `/api` prefix (`API_PATH`,
  `dsh-client-connection/lib/types/api-path.d.ts`), a prefix route bridged by `bridge()`
  (`dsh-client-connection/lib/index.js:767-780`, `types/http-bridge.d.ts`).
- Envelopes (`stream-protocol.d.ts:131-159`):
  - client→host: `{type:'open', streamId, endpoint, payload}` | `{type:'cancel', streamId}`
  - host→client: `{type:'item', streamId, value?}` | `{type:'error', streamId, error:{code,message,details}}` | `{type:'end', streamId}`
  - Text frames only (binary → close 1003; unparseable → close 1008). Server is
    `new WebSocketServer({ noServer: true })` (`index.js:203`) with no `maxPayload` override.
- **Logical endpoints** are `<namespace>/<method>`. Chat streaming is `session/follow`, a Typert
  **stream** method (`dsh-api-session-controller/lib/typert.remote-client.d.ts:42`); live control is
  `session/control`; forwarded Cordis events use gateway-internal `$events` / `$events/result`
  (`stream-protocol.d.ts:6-8`).
- A `session/follow` item's `value` is `SessionFollowFrame`
  (`dsh-api-session-controller/lib/types/types.d.ts:441-500`):
  `{type:'snapshot',header,cursor,records,hasMore,projections,assistantStream?}` |
  `{type:'event',event:SessionEvent}` | `{type:'assistant-stream',frame:SessionAssistantStreamFrame}`.
- SSE exists only off the model path: provider wire and client HMR (`dsh-client-hmr/lib/index.js:117`).
  Nothing in the browser session stream is SSE.

## 4. Live partial answer vs the persisted log
Two fan-outs from the same `live.push(chunk)` (`dsh-agent-loop/lib/index.js:1042`):
- **Durable (settlement only).** `AssistantStreamAttempt` (`dsh-agent-loop/lib/index.js:358-470`) holds
  one `AssistantStreamAccumulator` + one `BlockAssembler`; nothing is appended per chunk. At settlement
  it appends exactly one event carrying the whole compact stream:
  `session.append('assistant/message',{turn,step,message,usage?,interrupted?,stream})`
  (`index.js:1050,1108`) or `'assistant/attempt',{turn,step,stream}` for failed/aborted/retried attempts
  (`index.js:1065,1070,1083`). Shapes: `dsh-session/lib/types/types.d.ts:309-331`; `stream` is
  `AssistantStreamRecord[]`, so replay is exact.
- **Transient (per chunk).** Every chunk emits `dispatch.emit('agent/assistant-stream',{frame})`
  (`index.js:1031-1032`). `AssistantStreamFrame` (`dsh-agent/lib/types/runtime-types.d.ts:107-140`) =
  `{type:'start',attemptId,revision,turn,step}` | `{type:'chunk',attemptId,revision,index,time,chunk}` |
  `{type:'end',attemptId,revision,index,outcome:{kind:'committed',eventType,seq}|{kind:'abandoned'}}`.
- Host fold: `SessionAssistantStreamAccumulator.accept(frame,durableCursor)`
  (`dsh-api-session-controller/lib/types/assistant-stream.d.ts:9-25`) caches the compact prefix per
  attempt and stamps `startedAfterSeq` from `cursorBeforeNext(session.seq)`
  (`api-session-controller/lib/index.js:1343-1352,1436-1441,1545-1548`). A follower that reconnects gets
  the prefix in `snapshot.assistantStream` (`SessionAssistantStreamBaseline`) and re-expands it.
- Client fold: `ClientAssistantStream` (`dsh-api-session-controller/lib/types/client/sessions/assistant-stream.js`).
  `acceptFrame('chunk')` yields a **transient** `assistant/live-chunk` entry
  (`client/contract/events.d.ts:6-16`) with a fractional ordering seq
  `durableCursor + 1 - 1/(transientInGap+1)` (lines 104-120), so it sorts after the last durable seq and
  before the next. `acceptDurable` stages the settlement in `pending` and releases it only when the
  matching `end` frame arrives with the same `seq` **and** `eventType` (lines 61-73,122-145); any
  index/seq mismatch returns `rebaseline`, and the client restarts the stream.
- UI: `dsh-client-ui-chat/lib/client.js` `updateChunk` (lines 4390-4445) accumulates
  `text-delta`/`reasoning-delta` into `{kind:'text'|'reasoning',text}` at `chunk.index`; `block-end`
  replaces the block via `toAssistantBlock`; `usage` updates state. On settlement `settleMessage`
  (4470-4478) replaces the block list with `event.data.message.content` — the final render derives from
  the durable event.
- Cadence: the assistant definition publishes chunk updates as `"animation-frame"`, settlement as
  `"immediate"`, and `usage`/`finish` as `"none"` (`dsh-client-ui-chat/lib/client.js:4595-4600`). The
  conversation assembler coalesces `animation-frame` publications through **three chained
  `requestAnimationFrame` calls** (~50 ms at 60 Hz) before flushing its snapshot
  (`dsh-client-ui-conversation/lib/client.js:2541-2555`; `client/contract/conversation.d.ts:152-153`).
Consequence: **the persisted log never contains a partial answer.** Live text/reasoning exists only as
process-local frames; the log gets one atomic settlement event, and the client's transient rows are
replaced by it.

## 5. Cordis events vs service methods
| event | mode | where |
|---|---|---|
| `llm/stream` | **waterfall** (`next()` reaches the adapter; a listener may yield its own chunks) | `dsh-llm/lib/types/index.d.ts:32-46` |
| `llm/adapters-updated` | emit | `dsh-llm/lib/types/types.d.ts:12-22` |
| `agent/assistant-stream` | **emit** (agent-scoped, scope-filtered) | `dsh-agent/lib/types/runtime-types.d.ts:365-375` |
| `agent/request-error` | **waterfall** (retry ownership) | `dsh-agent/lib/types/runtime-types.d.ts:~310-355` |
| `agent/status`, `agent/error` | emit; `agent/turn-stopping` **serial** | `runtime-types.d.ts:222-296,394-409` |
| `session/created`, `session/disposed`, `session/event` | **emit** (post-commit, fire-and-forget) | `dsh-session/lib/types/index.d.ts:30-69` |
| `session/flush` | **parallel** (awaited durability checkpoint) | `dsh-session/lib/types/index.d.ts:69-75` |
| `api-session/added\|removed\|status\|activity\|error` | emit | `dsh-api-session-controller/lib/types/types.d.ts:~530+` |
No `bail` event participates in streaming. Only an explicit allowlist reaches the browser —
`API_REMOTE_FORWARDED_EVENTS` (`dsh-api-remotes/lib/index.js:18-85`), each entry declaring `emit` or
`waterfall`. **`agent/assistant-stream` is deliberately not on it**; live chunks reach the browser via
`session/follow` instead.
Service methods (not events): `ctx.llm.stream(options)` / `prepareCall()` / `registerAdapter()`
(`LlmRuntime`); `session.append(type,data,...opts)` (synchronous, returns the committed `SessionSeq`)
and `session.flush()`; `agent.send/steer/followup`; the projection registry `ctx.sessionProjections`
(`onChanged`, `dsh-session-projection/lib/types/index.d.ts:86,117+`) whose folds run over **committed**
`session/event` values only, so it is not a live path. On the wire, `ctx.remote.session.follow(request)`
is a generated Typert **stream** method dispatched by `typertGateway.stream()`; unary methods go
through `typertGateway.invoke()` (`dsh-api-gateway/lib/index.js:538-564`).

## 6. Numbers that matter
- WebSocket heartbeat: `websocketHeartbeatIntervalMs` default **2000 ms**
  (`dsh-api-gateway/lib/types/index.js:16`); ping every interval, terminate after **2** missed pongs
  (`MAX_MISSED_HEARTBEATS = 2`, `dsh-api-gateway/lib/index.js:197,252-267`).
- HTTP RPC body cap: **300 MiB** (`DEFAULT_MAX_REQUEST_BODY_BYTES = 300*1024*1024`, configurable via
  `maxRequestBodyBytes`, `dsh-client-connection/lib/index.js:24,741,754`); bodies buffer in memory, so
  this is also the per-request resident bound (`types/http-bridge.d.ts:7-11`).
- WebSocket inbound frame cap: `ws` default **100 MiB** (no `maxPayload` configured).
- Backpressure: the host serializes frames per connection through a promise chain and awaits every
  `socket.send` callback, so a slow socket throttles its pump (`RemoteStreamMuxConnection.send`,
  `dsh-api-gateway/lib/index.js:~355-390`). The browser `StreamInbox` is an **unbounded** Deque
  (`dsh-api-gateway/lib/types/client/stream-client.js:~250-275`).
- Reconnect: first-retry delay 50–100% of `backoffBaseMs` (default **500 ms**), factor **2**, cap
  **10 000 ms**; slow-handshake warn **3000 ms**; readiness deadline **15 000 ms**
  (`dsh-client-connection/lib/types/recovery-config.d.ts:4-18`).
- Live coalescing: **3 chained `requestAnimationFrame`s** (~50 ms at 60 Hz).
- Persistence batching: **200 ms** bounded window per session before the live buffer drains to storage
  (`dsh-session-persistence-jsonl/lib/index.js:181-189`); `session/flush` forces a drain.
- Follow snapshot page: `DEFAULT_MAX_MESSAGES = 50` (`dsh-api-session-controller/lib/index.js:1328`).
- Paths/port: API prefix `/api`, WebSocket mux `/api/remote.mux`. Web-server port is **required config**
  (`dsh-host-webserver/lib/types/index.d.ts:47-52`), host `127.0.0.1|0.0.0.0`; this deployment serves the
  GUI on `127.0.0.1:3080`. Compression default `none`; when enabled gzip level 1, threshold 1024 bytes,
  and `text/event-stream` is excluded (`dsh-host-webserver/lib/index.js:103-114`).
- Close codes: 1000 disposed, 1003 binary, 1008 invalid request, 1011 undeliverable, 4000 reconnect, 4002 invalid frame.

## What a reimplementation must do
Minimum mechanism to stream text **and** reasoning live to a browser:
1. **Chunk vocabulary.** One discriminated union with distinct `text-delta` / `reasoning-delta` /
   `tool-call-delta` variants plus `block-start`/`block-end`/`usage`/`finish`, indexed by block, over an
   `AsyncIterable`. Reasoning must be its own block type end-to-end — never folded into text.
2. **Assembler.** Accumulate per-index partials from deltas; close on `block-end` or at stream end;
   produce a frozen message whose content keeps text and reasoning blocks in stream order.
3. **Dual fan-out per chunk.** (a) append a compact lossless delta run to an in-memory attempt and
   commit **one** durable settlement event on completion/cancel/error; (b) publish a transient frame
   `{attemptId, revision, index, time, chunk}` immediately. Bump a monotone attempt id/revision so a
   client can detect gaps.
4. **Single multiplexed WebSocket.** Path `/api/remote.mux`; client `{type:'open', streamId, endpoint,
   payload}` / `{type:'cancel', streamId}`; server `{type:'item', streamId, value}` then
   `{type:'end'|'error', streamId}`. Every logical stream shares it; support re-open after reconnect.
5. **Live session stream endpoint.** `session/follow` with opt-in `assistantStream:true`. The opening
   frame carries a reconnect baseline (active attempt id, `startedAfterSeq`, `nextIndex`, compact prefix
   expanded back to chunks); later items interleave durable events and `{type:'assistant-stream',frame}`.
   Drop chunk frames until a known `start`.
6. **Client fold.** Order transient rows with fractional seqs between the last durable seq and the next;
   accumulate deltas into render blocks by `index`; on the settlement `end` frame (same seq + event
   type) replace transient rows with the durable `assistant/message` content; on any index/seq gap,
   rebaseline rather than render a hole.
7. **Batching + settle semantics.** Coalesce UI publications to animation frames but render settlement
   immediately; never present a transient state as final, and never persist a partial assistant message.
