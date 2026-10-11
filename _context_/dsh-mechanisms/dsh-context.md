---
title: DSH Context Management
level: L2
version: 1.1.0
description: How DSH assembles, prunes, budgets and compacts the context of one model call, corrected against the installed DSH 0.2.0-rc.2 and guarded by a check beside it.
status: unverified
grounded_in:
  - source: the installed DSH packages under ~/.volta, version 0.2.0-rc.2, read on 2026-10-11 and re-verified symbol by symbol the same day
  - source: check-reading.mjs beside this file, which asserts the load-bearing facts and reports unjudged when no DSH install is present
---

# DSH Context Assembly, Retention, Compaction and Token Budgeting

Paths are relative to `<pkg>` = `/Users/zhenc/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`; line numbers are from the shipped `lib/*.js` of **DSH 0.2.0-rc.2**. Runtime fact: the shipped `standard` preset is
`dsh-web-app/presets/standard.patch.yml` — **not** `dsh-agent-presets/presets/standard/agent.cordis.yml`, which does not exist in this install. It mounts `compaction-basic` with **no** config (`standard.patch.yml:70-71`, so every default below applies) and `tool-result-pruner` with the explicit
defaults `8192/4096/1024` (`:74-79`), which equal that plugin's own defaults.

Two reading rules follow from how this file has aged. First, the check beside it asserts the facts
below; when the check fails, this reading is stale rather than the code being wrong. Second, every
correction carries the line that decides it, because v1.0.0 of this file got thirteen of them wrong
by reading a summary of the code instead of the code — they are listed at the end.

## 1. Building one model call's message list

There is no separate context-assembly module; the request *is* the derived surface plus the logged header
(`ReactLoopAgent.buildRequest`, `dsh-agent-loop/lib/index.js:1202-1277`):

```js
return markAgentLoopRequest(Object.freeze({
  ...header.config,
  messages: boundaryMessages,              // :1262 = session.deriveMessages()
  toolHistory: session.toolHistory(),      // :1272
  ...header.tools !== void 0 ? { tools: header.tools } : {},
  sessionId: this.session.id,
  signal
}));
```

Two details v1.0.0 missed: the request carries **`toolHistory`** (`:1272`, so the runtime can project
deferred and retained tool definitions), and the system prompt is **not** a request field —
`validateSessionEventData` rejects `header.system` outright (`dsh-session/lib/index.js:264`,
`must omit header.system; use system/message`); it travels as a `system/message` surface node.

Per-step order (`agent-loop:902-925` preStep, `:1041-1160` step, `:1163-1200` prepareRequest,
`:1202-1277` buildRequest):

1. **Inbox claim** (`:104-105`): all queued next-step input, plus exactly one next-turn prompt when
   `target === "next-turn"`.
2. `await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))` (`:907`).
3. `renderContextSections(assembly)` + `RuntimeContextProjection.project(...)` (`:909-910`) → one
   optional sourced `user/message` runtime-context **snapshot** (`source.kind = "runtime-context"`
   `:218`, `form: "snapshot"` `:343-347`); it is skipped when unchanged.
4. **`agent/pre-step` waterfall** (`:911`) — the step-admission hook. `compaction-basic` runs its
   `pressure` check here (`compaction-basic:839`) and `dsh-agent-instructions` splices its baseline
   after the claimed messages (`agent-instructions:1271-1289`).
5. `prepareRequest()`: **`agent/request` waterfall** (`:1179`) → `ctx.llm.prepareCall(config, signal)`
   (`:1189`). This is a **second** pre-request hook — v1.0.0 called `agent/pre-step` the only one.
   It runs after pre-step, so pre-step compaction changes what is derived.
6. `SystemPromptProjection.project` (`:239-296`) emits ordered `system/message` commits: append when
   none exists (`:266-269`); otherwise per-node `{op:'replace',startSeq,endSeq}` head rewrites with
   stale later system nodes replaced by **durable** empty events, not log lines (`:272-275`,
   `replace()` at `:284-297`); and in a continuing request series with history, a changed non-empty
   prompt is **appended** as a new node (`:277-281`). The head is rewritten only when its text differs.
7. First attempt only (`:1061`): `session.append('user/message', message, {surfaceOp:'append'})`.
8. `request/header` with reasons `initial|resume|change|series` (`:1214-1228`), `request/context` when
   any field differs (`:1252-1259`), and a `developer/message` recording tool additions/removals
   (`:1240-1247`); then `session.deriveMessages()` (`:1262`).
9. `preparedCall.stream(request) ?? ctx.llm.stream(request)` (`:1072`).

Terminal failure runs the `agent/request-error` waterfall (`:1124`); `{kind:'retry'}` re-enters the
`while(true)` loop at `prepareRequest` (`:1133-1134`), so assembly is not repeated — but
`systemPrompt.project` (`:1052`) and `buildRequest` (`:1063`) are.

Ordering conclusion, unchanged from v1.0.0: `deriveMessages` over `surface.nodes` is the substrate;
pruning and compaction mutate the log/surface *before* derivation; instructions and injected context
are ordinary surface appends that also precede derivation. There is no post-derivation truncation.

## 2. Compaction

**Contract.** `ctx.compaction` = abstract `CompactionEngine extends Service` (`dsh-compaction/lib/types/index.d.ts:102,116,137,157`; the runtime class is `dsh-compaction/lib/index.js:169-173`, `super(ctx, "compaction")`).
`CompactionResult` (`types.d.ts:102-131`) carries `compactionId`, `startSeq`, `summarySeq`, `endSeq`,
`summary`, `shadowedRange{start,end}`, `shadowedSeqs[]`, `shadowedTokenCount`, and an optional
`sourceCommandId`. `shadowedRange` is a surface **position** span, so `start` may exceed `end`
(`types.d.ts:119-121`).

**Triggers** (`dsh-compaction-basic/lib/index.js`):

- automatic step pressure on `agent/pre-step` (`:839`), gated on
  `measurement.totalTokens >= spec.thresholdTokens` (`:941`);
- provider-confirmed overflow on `agent/request-error` when
  `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` (`:861-862`), bypassing the threshold **and** the
  retention floor with `selectCompactableRange(..., 0)` (`:932`), and authorizing a retry only after
  `surface.replaceGeneration` advances (`:883-886`);
- explicit `/compact` → `compactNow(...)` (`dsh-command-compact/lib/index.js:55,93-98`).

`compactionRetries` gives extra attempts while pressure remains (`:948`) and the engine **throws** if
it is still above threshold afterwards (`:960`). Pressure configuration that cannot resolve throws a
target-specific error rather than guessing (`:940`, and the automatic listener warns once then skips).

**What it produces.** The transaction appends **four** events with exactly one surface mutation
(`:469` `compaction/start` log-only lock; `:634` `compaction/summary` log-only; `:650` the replacement
`user/message`; `:484`/`:495` `compaction/end`). The replacement carries the mutation and its
provenance:

```js
session.append("user/message", checkpointMessage, {
  surfaceOp: { op: "replace", startSeq: start, endSeq: end },
  sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs]
});                                             // :650-661
```

v1.0.0 said five appends with one surface mutation. Pruning is the fifth *kind* of event and it comes
from the pruner, not this transaction, and each prune is itself a surface mutation — see §3.

Replacement content is `frameSummary` (`:344-355`): `CHECKPOINT_PREAMBLE` + `\n\n<compacted-summary>`,
the summary's blocks, then `</compacted-summary>` (tags `:234-235`, preamble `:280`). Its source is
`compactCheckpointSource(compactionId, sourceCommandId?)` = `{ kind: "compact-checkpoint", compactionId,
sourceCommandId? }` (`dsh-compaction/lib/index.js:109,116-121`), tested by `isCompactCheckpointSource`
(`:128-130`). v1.0.0 printed a `{kind:'plugin', plugin:'compact', …}` shape that does not appear
anywhere.

**Where stored.** All events go into the append-only log; the replacement *becomes* the surface node
at the shadowed position (`applySurfacePlan` splices `state.nodes`, `dsh-session:462-465`), and the
shadowed events stay in the raw log, so replay is exact. A summary that does not shrink is rejected
(`:600-601`):

```js
const framedSummaryTokenCount = dependencies.meter.estimateMessage(checkpointMessage);
if (framedSummaryTokenCount >= prepared.shadowedRouteTokenCount) throw new Error(`summary is not smaller than the shadowed content (…)`);
```

The summarizer replays the derived `system/message` at node 0 when there is one (`:695-697`), the
shadowed region's messages (`:698-703`), `header.tools` when present (`:701`), plus `toolHistory`,
`sessionId` and `purpose: "compaction"` (`:316,319,320`) and `maxTokens` (`:305-321`), with the
compaction instruction as the final user message — so the auxiliary call is a genuine prefix of the
last routed request. Only returned text enters the checkpoint. A failed summary leaves the latest
durable surface in place and the run proceeds over budget.

**Range selection** (`selectCompactableRange`, `:410-432`): start at the first **non-system** surface
node (`const firstIdx = systemHead(session, surfaceNodes[0]) === void 0 ? 0 : 1`), walk the tail
accumulating `nodes[].tokens` until `>= retainTokens`, then decrement `keepFromIdx` while
`toolPairingBalancedBefore(...)` is false, so no assistant `tool-call` is split from its `tool/result`;
return `null` when nothing safe remains. **v1.0.0 said node 0 is never shadowed; the code protects
node 0 only when node 0 is a `system/message`** — with no system head the range starts at node 0.

**Capacity** is resolved from the adapter that owns the durable route (`:936`
`ctx.llm.resolveModelInfo(...)`), and missing capacity throws a target-specific configuration error
(`:940`). Thresholds and retention can be overridden per provider/model through `modelPolicies`
(`README.md`, `resolveTargetPolicy`).

## 3. Pruning

`ctx.toolResultPruner` = `ToolResultPruner extends Service`, `static inject = ['tokenMeter']`
(`dsh-compaction-tool-result-pruner/lib/index.js:61-195`). Defaults `thresholdChars 8192`,
`headChars 4096`, `tailChars 1024` (`:10-14`) with the load-time invariant
`headChars + marker + tailChars <= thresholdChars` (`:43-44`); marker
`"\n\n[... tool result middle pruned ...]\n\n"` (`:8`); slicing is by Unicode code point, so surrogate
pairs never split (`:25-27,104,111`); non-`text` blocks are kept (`:100-103`).

**There is no ranking.** `pruneSession` walks `session.surface.nodes` in surface order and prunes each
`tool/result` whose own summed text exceeds the threshold — the budget is per result, not summed across
nodes and not sorted (`:79-83,93,137-146`). v1.0.0's "ranks the results" was wrong.

**When:** only inside `compactIfNeeded`, after the pressure threshold has already qualified, or in the
overflow path (`compaction-basic:926-946`); the session is re-measured afterwards, and if pruning
cleared the pressure, summarization is skipped. Below-pressure conversations are never touched.

**What it writes:** a log-only `compaction/prune` immediately before a surface-mutating replacement
(`pruner:159-177`):

```js
session.append("compaction/prune", { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq],
  shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original) });
const replacement = session.append("tool/result", { ...event.data, message },
  { surfaceOp: { op: "replace", startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
```

Session validates that a `tool/result` replacement changes **only** content (`dsh-session:391-409`).

Separately, `dsh-spill-policy` (opt-in) replaces oversized results *before* they become history via
`tools/post-execute` with `{prepend:true}`, appends a retrievable locator and hint, and handles text
and image blocks (`dsh-spill-policy/lib/index.js:127,142-143,147-166,237-255`). Its switch is
**`maxInlineTokens`** — a token budget, not bytes — and it uses its own `retainContent`/`fitText`, not
`TextRetainer` (which lives in `dsh-output-retention`).

## 4. Token accounting

One service, `ctx.tokenMeter` = `TokenMeter extends Service`
(`dsh-token-meter/lib/index.js:606`), `static inject = ["sessionProjections"]` (`:607-608`) and a
config that throws on any key (`:603,612`). It makes no model calls, and keeps one replay fold per
session (`:609,706,730`).

**Local estimate** (`dsh-token-meter/lib/types/estimate.js`): `CHARS_PER_TOKEN = 4`,
`BLOCK_OVERHEAD = 4`, `ROLE_OVERHEAD = 4` (`:9,11,13`).

| Block or message | Estimate | Line |
|---|---|---|
| `text`, `reasoning` | `ceil(len/4) + 4` | `:40` |
| `tool-call` | `ceil(name/4) + ceil(arguments/4) + 4` — two ceilings, not one | `:43-45` |
| any other block | `4 + ceil(JSON.stringify(block).length/4)` | `:27` |
| `image` | as above over the block **minus `offloaded`** | `:24-25` |
| system message | `ceil(chars/4) + ROLE_OVERHEAD`, `0` when empty, no block overhead | `:64-72` |
| tools | `ceil(JSON.stringify(header.tools).length/4) + 4`, `0` when absent or empty | `:90-94` |

There is **no `tool-result` block arm**: a tool result is a `role:'tool'` message and prices as
`estimateContent(content) + ROLE_OVERHEAD` (`:79-82`). v1.0.0's "recursive content + 4" described an
arm that does not exist.

**Provider usage anchor** (`index.js:650-661`): used only when the anchor's canonical header equals the
measured header **and** `usageTokens(usage) >= estimatedAnchorTokens`, where
`usageTokens = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) + outputTokens` (`:594`).
Otherwise the baseline is `kind:'estimated'`, and there is a third value v1.0.0 omitted —
`kind:'none'` when there is no header and the surface is empty (`:663-667`).
`totalTokens = max(0, baseline.tokens + surfaceDeltaTokens)` (`:680`). `nodes[].tokens` is
route-priced while `nodes[].heuristicTokens` is route-independent and supplies shadow prices
(`:543-544,577-579`; `compaction-basic:576`).

**UI projections**: `tokenUsage` (`:442-445`, provider-reported cumulative), `contextPressure`
(`:509-513`), `contextBreakdown` (`:261-264`). They are documented as "a user-facing reference, not a
billing or gating input", each "a last-wins record of a different moment"
(`dsh-token-meter/lib/types/projection.d.ts:21-25,47-54`).

## 5. System prompts and instructions

**Sections** come from `ctx.systemPrompt.section({name, order, text})`, ordered ascending by order
then by code-unit name (`dsh-system-prompt/lib/index.js:97-98`). The full table is
`SECTION_ORDERS` at `:10-38`; the ends of it are the ones that matter here:

```
HARNESS_IDENTITY: -1e3      DEPLOYMENT_PERSONA_PREFIX: 0
… tool sections 1e3 … 5e3 …
DELIVERABLE_FILE_REFERENCES: 9e3   STRUCTURED_OUTPUT: 9900
HARNESS_SOURCE: 1e4         WEB_SURFACE: 10100      DEPLOYMENT_PERSONA_SUFFIX: 10200
```

The harness identity text is `You are an AI agent powered by DeepSeek Harness.` and is gated by
`config.includeHarnessIdentity ?? true` (`:215-219`); `complete: true` replaces the **section list
only** — tools, variables and contexts survive — and more than one such section throws (`:335-336,356-361`).

**Assembly:** `assemble()` merges the global and agent-scope layers with scope shadowing (`:317-319`),
detaches tool parameters (`structuredClone`, `:324-329`), runs the scope-filtered
`system-prompt/assemble` waterfall (`:355`) and applies runtime-context suppressors (`:356-361`);
`renderPrompt()` interpolates, drops empty sections and joins with a blank line (`:113-114`). Tool
schemas take part in the same assembly (`:352`) and `validateToolOrder` requires an
`<unlisted-tools>` entry (`:68-77`). `ctx.systemPrompt.variable(name, provider)` supplies `{{name}}`
(`:297-300`, interpolation `:153-177`); the loop supplies `provider`, `model` and `cwd`
(`agent-loop:1564-1566`).

**Injection:** the rendered prompt becomes the `system/message` surface node — appended when absent,
otherwise rewritten in place, with the empty-replacement and in-history cases of §1 step 6.

**Per-project instruction files** (`dsh-agent-instructions`, a plain `apply(ctx, config)` plugin with
`inject = ["sessionProjections"]`, `:1073,1099`) compose **one** durable user-role baseline at the first
eligible `agent/pre-step`; the hook runs on every step and reuses the baseline while
`baselineIdentity` matches (`:1271-1289,1125-1131,1160`).

- **Root.** Climb until a marker **is present** — `for (const marker of markers) if (await
  existsAsMarker(join(current, marker), …)) return current;` (`:480-487`), markers defaulting to
  `['.git']` (`:16`). v1.0.0 had this inverted ("until the probe is absent").
- **Chain.** The user-global `$DSH_HOME/AGENTS.md` (`:561`, name at `:141`) followed by every existing
  candidate from root down to `session.header.cwd`, broad to specific (`:495-507,578,1122`).
- **Candidates.** Base `['AGENTS.md','CLAUDE.md']`, local overlays
  `['AGENTS.local.md','CLAUDE.local.md']` (`:17-18`); content-identical (trimmed SHA-1) files render
  once per directory (`:101-103,632-647`).
- **Budget.** `maxBytes` is required (`:28`, 65536 in the standard preset): broader files are dropped
  **whole** before the most specific is truncated (`:307-352`), and the notice
  `Workspace instruction budget ${maxBytes} bytes: …` names the omissions (`:254`) as the first block
  inside the `<system-reminder>` frame (`:111-112,256-265`).
- **Delivery.** A `<system-reminder>`-framed `user/message` with `source.kind = 'agent-instructions'`,
  `baseline`, `baselineIdentity` and `changes` (`:765,1200-1209`).
- **Refresh.** There is no watcher. Successful first-party `read`/`write`/`edit` results are tracked
  through `exec.arguments.file_path` (`:1087-1098`) off `tools/result` (`:1290-1309`), flushed after the
  enclosing `step/end` (`:1254-1270`) and reconciled into the inbox (`:1211-1230`); changed files
  replace, disappeared files and previously-visible duplicates produce a removal notice (`:1003-1006,
  1021-1024`), an unchanged path plus digest is never re-injected (`:1013,1032`), and a shell `cd`
  triggers nothing — only nested directories under a touched path are discovered (`:940`).

## 6. "Projection" now has three meanings

**(a) Message projection.** `deriveEventMessage(event, projectedMessages?)`
(`dsh-session/lib/index.js:214-227`): a `projectedMessages` short-circuit first (`:215-216`), then
`user/message` → `event.data`; `system/message`, **`developer/message`** and `assistant/message` →
`event.data.message` unless `content.length === 0` (then `null`); `tool/result` → `event.data.message`;
everything else `null`. `Session.deriveMessages()` folds it over `surface.nodes` (`:1554-1569`), caching
on **`contentGeneration`** — not `replaceGeneration` as v1.0.0 said (`:1557-1558`); a replace bumps
both (`:463-465`), and `replaceGeneration` keys a different cache, the tool-pairing balance
(`dsh-compaction/lib/index.js:50-52`). It returns a fresh array whose messages are shared and
deep-frozen.

**(b) The surface plan kind `project`.** `applySurfacePlan` has **three** kinds — `append`, `replace`,
`project` (`dsh-session:460-470`) — and the third registers plugin-owned pure interpreters
(`MESSAGE_PROJECTION_EVENT_TYPES = image/offload`, `:141`) that substitute the message an event
derives to. `foldSurface(events, projections)` throws when an interpreter a log needs is missing
(`:486-490`). Projections therefore participate in *deriving model input*, which is more than the
parallel registry v1.0.0 described.

**(c) The session projection registry.** `ctx.sessionProjections` = `SessionProjectionRegistry extends
Service` (`dsh-session-projection/lib/index.js:44`, name at `:52`). A `ProjectionDefinition` is
`{key, stateSchema, stateVersion, init, apply, wire?}` (`lib/types/index.d.ts:38-80`); the registry
subscribes to `session/event` once and eagerly passes every committed event through every unit's
synchronous `apply` (`:64-66,402-414`). Per-session cells hold state plus a watermark seq and a
two-slot view cache (`:57-61`); a client-visible key publishes only when the state reference changed,
there are listeners, and `Object.is(views[0], views[1])` is false (`:416-425`). A `stateVersion`
mismatch discards persisted rows (`{ver,seq,val}`, `:200-204`), registration is an effect on the
calling fiber (`:82`, disposal `:94-100`), and a shrunken log is detected by a one-below `restoreFloor`
anchor (`:231,296`). Consumers use `snapshot()` → `{asOfSeq, values}`, `stateOf(session,key)` and
`onChanged(listener)` (`:142-156,127-132,110-118`). `dsh-session-projection-cache` persists
`{identity, rows}` as `<root>/session_projcache/sessions/<id>.json`, written at session creation,
`turn/end` and disposal plus `writeEveryEvents`/`writeIntervalMs` throttles, fail-soft, and it may lag
the log (`dsh-session-projection-cache/lib/index.js:90-101,293-337,352-355`;
`dsh-storage-json/lib/index.js:277-278,463`).

## 7. Cordis services/events vs plain functions

**Services (`Service` subclasses):** `ctx.compaction` (`CompactionEngine`, abstract),
`ctx.toolResultPruner`, `ctx.tokenMeter`, `ctx.sessionProjections`, `ctx.systemPrompt`,
`ctx.sessions`, `ctx.agents`, `ctx.agentDefaultModel`.

**Cordis events** (mode from the `.d.ts`): `agent/pre-step` *waterfall* — the step-admission seam used
by compaction, instructions and runtime context — plus **`agent/request`** *waterfall* (the call-config
seam, `agent-loop:1179`), `agent/request-error` *waterfall* and `agent/turn-stopping` *serial*; *emit*:
`agent/created`, `agent/disposed`, `agent/status`, `agent/inbox/inserted|claimed|discarded`,
`agent/session-start`, `agent/assistant-stream`, `agent/error`, `system-prompt/change`,
`agent-preset/selected`; `session/created|disposed|event` *emit* and `session/flush` *parallel*;
`system-prompt/assemble` *waterfall*; `tools/result`. All are registered as plain
`ctx.on(name, (payload, next) => …)`.

**Session-log events** (declaration-merged into `SessionEventMap`, not Cordis events): the five
surface-eligible types — `system/message`, **`developer/message`**, `user/message`, `assistant/message`,
`tool/result` (`dsh-session:154-160`) — which alone may carry `surfaceOp` (`:299`); the log-only
`compaction/start|summary|end|prune`; `request/header`, `request/context`, `step/start|end`,
`turn/start|end`, `session/end-seed`, `agent/inbox/spliced`, `llm/retry`, `llm/retry-started`.

**Plain functions:** `deriveEventMessage`, `foldSurface`, `applySurfacePlan`,
`isSurfaceEvent`/`isAppendSurfaceEvent`/`isReplacementSurfaceEvent`,
`assertSystemHeadRewrite`/`assertToolResultRewrite` (session); `toolPairingBalancedBefore/After`,
`compactCheckpointSource`, `isCompactCheckpointSource`, `ManualCompactionError` (compaction);
`resolveConfig`, `resolveTargetPolicy`, `resolveCompactSpec`, `selectCompactableRange`,
`prepareCompaction`, `buildSummarizationInput`, `frameSummary`, `summarizeWithLlm`
(compaction-basic); `estimateMessage`, `estimateContent`, `estimateSystemMessage`,
`estimateToolsTokens`, `estimateStructuralBlock` (token-meter); `codePointLength`, `PRUNE_MARKER`
(pruner); `renderPrompt`, `renderContextSections`, `joinContextSections` (system-prompt).

## How this reading is kept honest

[`check-reading.mjs`](check-reading.mjs) asserts the load-bearing facts above against the install,
through the project's runner:

```bash
node _tools_/verify-runner/run.mjs _context_/dsh-mechanisms/check-reading.mjs
```

It reads files only, spends nothing, and keeps the project's contract: `0` when the reading still
describes the install, `1` when it does not, and `3` when no DSH install is found — a reading that
cannot be checked is never reported as holding. The install location is machine configuration, so it
is taken from `$HEDDLE_DSH_ROOT` first and otherwise from the usual install paths.

## Minimum viable reimplementation

1. **Append-only event log plus a positional surface.** Keep every event; maintain `surface.nodes:
   seq[]` where only the five message-producing types may append or replace and everything else
   (chunks, boundaries, lock markers) is log-only. This one structure gives retention, replay and
   compaction without a second copy of history.
2. **One projection function** `event → Message | null`, folded over `surface.nodes` per request,
   with an optional interpreter hook. Cache it, extending on append and rebuilding when a replace
   bumps the generation; the `system/message` node is the system prompt, not a request field.
3. **A token meter** with a deterministic estimate (`ceil(chars/4)` plus fixed block and role
   overhead) and an optional provider-usage anchor reused only for an identical envelope; expose
   `measure(session) → {totalTokens, nodes:[{seq, tokens, heuristicTokens}]}`.
4. **Budget resolution** `threshold = floor(contextWindow × 0.8)` and
   `retain = floor(contextWindow × 0.16)`, requiring `retain < threshold`, with the capacity resolved
   from the adapter rather than hardcoded, and per-model overrides.
5. **Prune before summarizing:** rewrite over-budget `tool/result` text to `head(4096) + marker +
   tail(1024)` as a `surfaceOp:'replace'` over exactly that node, with a `compaction/prune` shadow
   price immediately before it, then re-measure and stop if pressure cleared.
6. **Compaction:** select the oldest span starting at the first non-system node, leaving a tail priced
   `>= retain`, cutting only at tool-call/result-balanced boundaries; summarize with one auxiliary call
   that replays the exact prefix plus the instruction; append
   `start-marker → summary-record → user/message{surfaceOp:'replace', sourceEventSeqs:[…]} →
   end-marker`; reject a summary that is not strictly smaller; store nothing outside the log.

Required order, each step consuming the previous step's state: **append input → derive messages from
the surface → measure → if over threshold: prune → re-measure → select range → summarize → replace the
span → re-derive → send.** Invariants: the range never begins at surface node 0 **when that node is the
system prompt**; a cut never separates a tool call from its result; the replacement is strictly smaller
than what it shadows; and the log retains both the original and the replacement events.

## What v1.0.0 got wrong

Each was found by reading the shipped code rather than this file, and each is asserted by
`check-reading.mjs` so it cannot come back.

1. `SURFACE_EVENT_TYPES` has **five** members, not four — `developer/message` was missing (`dsh-session:154-160`).
2. `compactCheckpointSource` is `{kind:'compact-checkpoint', …}`, not `{kind:'plugin', plugin:'compact', …}` (`dsh-compaction:109,116-121`).
3. A compaction transaction appends **four** events; `compaction/prune` belongs to the pruner and each one mutates the surface (`compaction-basic:469,484,634,650`; `pruner:159-177`).
4. Surface node 0 is protected only when it is a `system/message` (`compaction-basic:415`).
5. The derived-message cache keys on `contentGeneration`, not `replaceGeneration` (`dsh-session:1557-1558`).
6. `agent/pre-step` is not the only pre-request hook; `agent/request` exists (`agent-loop:1179`).
7. The token meter has no `tool-result` block arm (`estimate.js:37-52,79-82`).
8. The usage baseline has three values, including `kind:'none'` (`token-meter:663-667`).
9. The shipped preset lives at `dsh-web-app/presets/standard.patch.yml` (`:16-19,70-79`).
10. `compaction-basic`'s summarization cap defaults to `headroomTokens` (65536), not 8192 (`compaction-basic:63-64`).
11. The pruner does not rank; it walks in surface order with a per-result budget (`pruner:79-83,93,137-146`).
12. The spill policy keys on `maxInlineTokens`, not bytes, and uses its own retention code (`dsh-spill-policy:127,142`).
13. The instruction root is found by climbing until a marker **is present**, not absent (`agent-instructions:480-487`).

Omitted rather than wrong, and now stated: the request's `toolHistory` field, the runtime-context
snapshot, the `developer/message` tool-change record, the in-history system-prompt append, and the
`project` surface-plan kind.

## Read next

[`INDEX.md`](INDEX.md) for what this instance holds, and
[`../../ULTIMATE_GOAL.md`](../../ULTIMATE_GOAL.md) for the parts these readings ground.
