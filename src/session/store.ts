import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Chunk, ContentPart, Message } from '../llm/types.ts'

/**
 * The session store.
 *
 * Modelled on `@deepseek-ai/dsh-session`: a session is an **event log**, not a
 * mutable conversation object. Each event is a line in one JSONL file, and the
 * file is opened for append, so a turn that is interrupted leaves a start with no
 * end — which is exactly what an interruption looks like and what a
 * rewrite-the-whole-file store cannot show.
 *
 * The shape differs from DSH's in one way, and for a measured reason. DSH keeps
 * its store under the workspace and writes through its own persistence plugins
 * because it must survive a machine and a UI layer; this one writes one directory
 * per session under `$HEDDLE_HOME/sessions`, which is what a single-process
 * harness needs and what makes the store something a person can read with `cat`.
 *
 * A session id is the directory's name; the transcript is `session.jsonl`; a
 * small `meta.json` records what the session is for, so a listing does not need
 * to parse every transcript.
 */

/** Identifies one session; the directory name under the store root. */
export type SessionId = string

/** One entry in the log. `seq` is monotonic within a session. */
export interface SessionEvent {
  readonly seq: number
  readonly at: string
  readonly type: string
  readonly [key: string]: unknown
}

/** What a caller gets back when it opens a session. */
export interface SessionHandle {
  readonly id: SessionId
  readonly dir: string
  /** Where the transcript is; a caller may cite it. */
  readonly transcript: string
}

/** A message as it is recorded, which is the shape a request needs too. */
export interface RecordedMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: readonly ContentPart[]
  /** Present on a `tool` message: which call this answers. */
  readonly toolCallId?: string
}

/** One session's metadata, written once and corrected rarely. */
export interface SessionMeta {
  readonly id: SessionId
  readonly created: string
  readonly cwd: string
  readonly endpoint?: string
  readonly model?: string
  readonly title?: string
  readonly turns: number
}

/** The default root, overridable so a check can use a scratch directory. */
export function defaultSessionRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HEDDLE_HOME ?? join(homedir(), '.heddle')
  return join(home, 'sessions')
}

/**
 * The **surface**: the positional view of a log, which is what a request is derived from.
 *
 * Modelled on `@deepseek-ai/dsh-session`'s surface, and the reason it exists is the one thing an
 * append-only log cannot do by itself: let something be *replaced* without being *erased*. A
 * compaction, a pruning and a rewritten system prompt all want the model to stop seeing an old
 * span while a person still can, and DSH gets that by keeping the log immutable and giving the
 * model a second, derived view of it.
 *
 * Two rules hold the whole thing up:
 *
 * - **Only message-producing events take a position.** Everything else — the rest of a streamed
 *   run, a request record, a compaction marker — is log-only, which is what lets the log carry the
 *   record of a rewrite without the rewrite becoming conversation.
 * - **What the harness wrote is not what a person said.** A system prompt, an instruction baseline
 *   and a compaction checkpoint are all model-visible messages, but none of them is a turn somebody
 *   took, so they are `context/note` events rather than `message` ones. That distinction is what
 *   keeps a transcript honest *by construction*: a view of the conversation shows `message` and
 *   chunk events, and a note cannot leak into it because it never claimed to be one. Measured the
 *   other way: with the checkpoint written as a user `message`, the Web UI showed a compaction to
 *   the reader as though they had typed it.
 * - **A replacement names positions, not a new history.** The replacement event is written later,
 *   so its `seq` is higher than everything it shadows; it splices the positions it covers and
 *   records which seqs it found there, so a replay is exact.
 */
export const SURFACE_EVENT_TYPES: ReadonlySet<string> = new Set(['message', 'context/note', 'assistant/chunk'])

/** How an event entered the surface. An event with no marker in an older log is an append. */
export type SurfaceOp = 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }

/** One landed replacement, kept so a reader can see what a node shadowed. */
export interface SurfaceReplacement {
  readonly seq: number
  readonly startSeq: number
  readonly endSeq: number
  readonly shadowedSeqs: readonly number[]
}

/** The positional view of a log: the nodes the model can see, in order. */
export interface SurfaceState {
  /** The `seq` of every node, in surface order — which is not seq order after a replacement. */
  readonly nodes: readonly number[]
  /** Bumped by an append and by a replacement: the derivation cache key. */
  readonly contentGeneration: number
  /** Bumped only by a replacement: "a rewrite has landed", which is what a retry waits for. */
  readonly replaceGeneration: number
  readonly replacements: readonly SurfaceReplacement[]
}

/** Whether an event type can take a position on the surface. */
export function isSurfaceEligible(type: string): boolean {
  return SURFACE_EVENT_TYPES.has(type)
}

/** Whether an operation is a replacement, narrowing its range. */
export function isReplacementOp(
  op: SurfaceOp | undefined,
): op is { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number } {
  return typeof op === 'object' && op !== null && op.op === 'replace'
}

/**
 * Fold a log into its surface.
 *
 * The chunk rule is where this store's own choice meets the surface: heddle records **every**
 * streamed chunk as it arrives, so an interrupted answer is not lost, while DSH settles a stream
 * into one message. The fold resolves that by giving the surface one node per run — the seq of its
 * first chunk — and deriving the run's message from the chunks that follow.
 */
export function foldSurface(events: readonly SessionEvent[]): SurfaceState {
  const nodes: number[] = []
  const replacements: SurfaceReplacement[] = []
  let contentGeneration = 0
  let replaceGeneration = 0
  let openChunk: number | undefined

  for (const event of events) {
    const op = event.surfaceOp as SurfaceOp | undefined
    if (isReplacementOp(op)) {
      const startIdx = nodes.indexOf(op.startSeq)
      const endIdx = nodes.indexOf(op.endSeq)
      if (startIdx === -1 || endIdx < startIdx) {
        throw new Error(
          `session event ${event.seq}: a replacement names a range that is not on the surface (${op.startSeq}..${op.endSeq})`,
        )
      }
      const shadowedSeqs = nodes.slice(startIdx, endIdx + 1)
      nodes.splice(startIdx, shadowedSeqs.length, event.seq)
      replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq, shadowedSeqs })
      contentGeneration += 1
      replaceGeneration += 1
      openChunk = undefined
      continue
    }
    if (isSurfaceEligible(event.type) && event.type !== 'assistant/chunk') {
      // A `message` the person or the model produced, or a `context/note` the harness wrote: both
      // take a position, and neither is a chunk run.
      nodes.push(event.seq)
      contentGeneration += 1
      openChunk = undefined
      continue
    }
    if (event.type === 'assistant/chunk') {
      if (openChunk === undefined) {
        nodes.push(event.seq)
        contentGeneration += 1
        openChunk = event.seq
      }
      const chunk = event.chunk as Chunk | undefined
      if (chunk?.type === 'done') openChunk = undefined
    }
  }

  return { nodes, contentGeneration, replaceGeneration, replacements }
}

/** The message one node derives to, or null when it produces none. */
export function deriveMessage(bySeq: ReadonlyMap<number, SessionEvent>, seq: number): Message | null {
  const event = bySeq.get(seq)
  if (event === undefined) return null
  if (event.type === 'message' || event.type === 'context/note') {
    const message = event.message as Message | undefined
    if (message === undefined || message.content.length === 0) return null
    return message
  }
  if (event.type !== 'assistant/chunk') return null
  const content: ContentPart[] = []
  for (let index = seq; ; index += 1) {
    const next = bySeq.get(index)
    if (next === undefined || next.type !== 'assistant/chunk') break
    const chunk = next.chunk as Chunk | undefined
    if (chunk === undefined) continue
    if (chunk.type === 'text-delta') content.push({ type: 'text', text: chunk.text })
    else if (chunk.type === 'reasoning-delta') content.push({ type: 'reasoning', text: chunk.text })
    else if (chunk.type === 'tool-call') content.push({ type: 'tool-call', id: chunk.id, name: chunk.name, arguments: chunk.arguments })
    else if (chunk.type === 'done') break
  }
  return content.length === 0 ? null : { role: 'assistant', content }
}

/** Index a log by seq, which every derivation over it wants. */
export function indexBySeq(events: readonly SessionEvent[]): ReadonlyMap<number, SessionEvent> {
  const bySeq = new Map<number, SessionEvent>()
  for (const event of events) bySeq.set(event.seq, event)
  return bySeq
}

/** The message one surface node derives to, or null when it produces none. */
export function deriveNodeMessage(events: readonly SessionEvent[], seq: number): Message | null {
  return deriveMessage(indexBySeq(events), seq)
}

/**
 * Where the transcript can be read.
 *
 * A session records under the directory its process ran in, and the record names
 * that directory, so the caller can decide whether a session belongs to them
 * rather than guessing from the store's shape.
 *
 * Every append is also handed to an `onEvent` listener, which is how the Web UI sees
 * a turn **while it is happening**. Reading the file on a timer would have worked and
 * would have been a second copy of the truth with its own lag; the listener fires from
 * the one write path, so what a browser shows is what was just written.
 */
export class SessionStore {
  readonly root: string
  private readonly onEvent: ((handle: SessionHandle, event: SessionEvent) => void) | undefined
  /**
   * Folded surfaces, keyed by session and the log length they were folded at.
   *
   * A log only ever grows, so its event count is a sound cache key — and a turn asks for the
   * surface once per round, which is exactly where re-folding a long log on every call would show.
   * Reading is still the truth: a cache miss falls back to folding the file.
   */
  private readonly surfaceCache = new Map<string, { readonly count: number; readonly state: SurfaceState }>()

  constructor(
    root: string = defaultSessionRoot(),
    options: { readonly onEvent?: (handle: SessionHandle, event: SessionEvent) => void } = {},
  ) {
    // `~` is expanded because the profile writes `~/.heddle/sessions` and a
    // literal `~` directory beside the project is the wrong place to put it.
    this.root = resolve(root.startsWith('~') ? join(homedir(), root.slice(1)) : root)
    this.onEvent = options.onEvent
  }

  /** Create a session directory and its metadata. */
  create(options: { readonly cwd?: string; readonly endpoint?: string; readonly model?: string; readonly title?: string } = {}): SessionHandle {
    const id = `session-${randomUUID()}`
    const dir = join(this.root, id)
    mkdirSync(dir, { recursive: true })
    const handle: SessionHandle = { id, dir, transcript: join(dir, 'session.jsonl') }
    writeFileSync(
      join(dir, 'meta.json'),
      `${JSON.stringify(
        {
          id,
          created: new Date().toISOString(),
          cwd: options.cwd ?? process.cwd(),
          ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.title !== undefined ? { title: options.title } : {}),
          turns: 0,
        },
        null,
        2,
      )}\n`,
    )
    appendFileSync(handle.transcript, '')
    this.append(handle, { type: 'session/created', cwd: options.cwd ?? process.cwd() })
    return handle
  }

  /** Open an existing session by id, or by the newest one when `id` is omitted. */
  open(id?: SessionId): SessionHandle | null {
    if (id !== undefined) {
      const dir = join(this.root, id)
      try {
        readFileSync(join(dir, 'meta.json'), 'utf8')
      } catch {
        return null
      }
      return { id, dir, transcript: join(dir, 'session.jsonl') }
    }
    const newest = this.list()[0]
    return newest === undefined ? null : this.open(newest.id)
  }

  /** Sessions newest first, from the directory names and their metadata. */
  list(): readonly SessionMeta[] {
    let names: string[]
    try {
      names = readdirSync(this.root)
    } catch {
      return []
    }
    const metas: SessionMeta[] = []
    for (const name of names) {
      if (!name.startsWith('session-')) continue
      try {
        metas.push(JSON.parse(readFileSync(join(this.root, name, 'meta.json'), 'utf8')) as SessionMeta)
      } catch {
        continue
      }
    }
    return metas.sort((left, right) => (left.created < right.created ? 1 : -1))
  }

  /**
   * Append one event.
   *
   * Synchronous on purpose: an event must be on disk before the thing it
   * describes happens, or an interruption loses precisely the event that says
   * what the run was doing. This is the same reasoning as "write at the event,
   * not at the end of it" in the runtime ledger.
   *
   * `options.surfaceOp` is how an event enters the surface: leave it out (or pass `'append'`) for
   * the ordinary case, and pass a `replace` range to shadow a span. A replacement is **validated
   * here**, before anything is written, because a log that carries a rewrite the surface cannot
   * fold is a log nothing can read afterwards: the range must be a real span of current positions,
   * a tool result may be rewritten only by a tool result for the same call, and a system prompt
   * sitting at the surface head may be rewritten only by a system message over exactly that node.
   */
  append(
    handle: SessionHandle,
    event: Omit<SessionEvent, 'seq' | 'at'> & { readonly type: string },
    options: { readonly surfaceOp?: SurfaceOp; readonly sourceEventSeqs?: readonly number[] } = {},
  ): SessionEvent {
    if (isReplacementOp(options.surfaceOp)) this.assertReplacement(handle, event, options.surfaceOp)
    const seq = this.count(handle)
    const record: SessionEvent = {
      seq,
      at: new Date().toISOString(),
      ...event,
      ...(options.surfaceOp !== undefined ? { surfaceOp: options.surfaceOp } : {}),
      ...(options.sourceEventSeqs !== undefined ? { sourceEventSeqs: options.sourceEventSeqs } : {}),
    }
    appendFileSync(handle.transcript, `${JSON.stringify(record)}\n`)
    // After the write, never before: a listener that saw an event the file does not
    // have would be a second truth, which is the failure this ordering prevents.
    this.onEvent?.(handle, record)
    return record
  }

  /**
   * Reject a replacement the surface could not fold or that would erase something it must not.
   *
   * Every rule here is one DSH enforces on its own session, and each exists because the failure it
   * prevents is silent: a range that is not a span would shadow a hole, a tool result rewritten by
   * something else would leave the model a tool answer for no call, and a rewritten system head
   * would replace the prompt with a user's sentence.
   */
  private assertReplacement(
    handle: SessionHandle,
    event: Omit<SessionEvent, 'seq' | 'at'> & { readonly type: string },
    op: { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number },
  ): void {
    if (!isSurfaceEligible(event.type)) {
      throw new Error(`session ${handle.id}: "${event.type}" is not surface-eligible and cannot replace a range`)
    }
    const state = this.surface(handle)
    const startIdx = state.nodes.indexOf(op.startSeq)
    const endIdx = state.nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx < startIdx) {
      throw new Error(`session ${handle.id}: replacement range ${op.startSeq}..${op.endSeq} is not a span of the surface`)
    }
    const shadowedSeqs = state.nodes.slice(startIdx, endIdx + 1)
    /**
     * The span is **positional**, and its seqs need not be ordered.
     *
     * This is the trap this validation used to fall into. A replacement is written later than what
     * it shadows, so it carries a high seq while sitting at an older position — and any span that
     * contains it therefore holds a seq *below* `startSeq`. Checking the seqs form a numeric
     * interval read that as "a node would be left inside the span" and refused it, which made
     * **every second compaction of a session** fail: measured, `shadowedSeqs: [5, 2, 9]` with
     * `fromSeq: 5, throughSeq: 9` is an ordinary span after one replacement, and DSH documents the
     * same shape (`start` may be greater than `end`). Taking the positions between the two
     * endpoints *is* the validation; there is no hole to check for, because the slice defines the
     * span rather than assuming it.
     */
    const events = this.read(handle)
    const replacement = isSurfaceEligible(event.type) ? (event.message as Message | undefined) : undefined
    const head = shadowedSeqs[0]
    const headMessage = head === undefined ? null : deriveNodeMessage(events, head)
    if (startIdx === 0 && headMessage?.role === 'system') {
      if (replacement?.role !== 'system' || shadowedSeqs.length !== 1) {
        throw new Error(
          `session ${handle.id}: the surface head holds the system prompt and may be rewritten only by a system message over exactly that node`,
        )
      }
    }
    for (const seq of shadowedSeqs) {
      const original = deriveNodeMessage(events, seq)
      if (original?.role !== 'tool') continue
      /**
       * A tool result may only be rewritten by a tool result for the same call — and only over
       * exactly that node.
       *
       * The rule is one-directional, as DSH's is: what it forbids is a *tool* replacement that
       * lands on anything but the one result it answers. A compaction may still shadow a span that
       * contains tool results, because that replacement is a user message and shadows a whole
       * balanced region rather than pretending to be the call's answer.
       */
      if (replacement?.role !== 'tool') continue
      if (shadowedSeqs.length !== 1 || replacement.toolCallId !== original.toolCallId) {
        throw new Error(
          `session ${handle.id}: a tool result may be rewritten only by a tool result for the same call, over exactly that node`,
        )
      }
    }
  }

  /** How many events a session holds, which is also the next event's `seq`. */
  count(handle: SessionHandle): number {
    try {
      return readFileSync(handle.transcript, 'utf8').split('\n').filter((line) => line.length > 0).length
    } catch {
      return 0
    }
  }

  /** Every event, parsed. A line that cannot be parsed is reported, not skipped. */
  read(handle: SessionHandle): readonly SessionEvent[] {
    const text = readFileSync(handle.transcript, 'utf8')
    const events: SessionEvent[] = []
    for (const [index, line] of text.split('\n').entries()) {
      if (line.length === 0) continue
      try {
        events.push(JSON.parse(line) as SessionEvent)
      } catch (error) {
        throw new Error(`${handle.transcript}:${index + 1} is not valid JSON — ${(error as Error).message}`)
      }
    }
    return events
  }

  /** The surface, folded from the log and cached until the log grows. */
  surface(handle: SessionHandle): SurfaceState {
    const count = this.count(handle)
    const cached = this.surfaceCache.get(handle.id)
    if (cached !== undefined && cached.count === count) return cached.state
    const state = foldSurface(this.read(handle))
    this.surfaceCache.set(handle.id, { count, state })
    return state
  }

  /** One node's message, or null when the node produces none. */
  deriveNode(handle: SessionHandle, seq: number): Message | null {
    return deriveNodeMessage(this.read(handle), seq)
  }

  /**
   * The messages a request carries: every surface node, derived in order.
   *
   * This is the whole point of the surface, seen from a caller's seat — a compaction or a pruning
   * shows up here and nowhere else, while `read()` still returns everything that ever happened.
   */
  deriveMessages(handle: SessionHandle): readonly RecordedMessage[] {
    const events = this.read(handle)
    const bySeq = indexBySeq(events)
    const messages: RecordedMessage[] = []
    for (const seq of this.surface(handle).nodes) {
      const message = deriveMessage(bySeq, seq)
      if (message !== null) messages.push(message)
    }
    return messages
  }

  /** Record a message and keep the metadata's turn count honest. */
  message(handle: SessionHandle, message: RecordedMessage): SessionEvent {
    const event = this.append(handle, { type: 'message', message })
    if (message.role === 'user') this.bumpTurns(handle)
    return event
  }

  /**
   * Record the assistant's answer from the chunk stream.
   *
   * One event per chunk rather than one per answer, for the same reason the
   * ledger is written at the event: a killed run should read as a partial answer,
   * not as no answer. The `assistant/completed` event that follows is what says
   * the answer finished.
   */
  assistantChunk(handle: SessionHandle, chunk: Chunk): void {
    this.append(handle, { type: 'assistant/chunk', chunk })
  }

  /**
   * Record which model call produced the answer, before it is made.
   *
   * The context facts ride along — the estimate, the budget, what was pruned and
   * whether a compaction ran — because they are the only place an assembly is visible
   * after the fact, and a budget nobody can see is a budget nobody can check.
   */
  modelRequest(
    handle: SessionHandle,
    request: {
      readonly endpoint: string
      readonly model?: string
      readonly messages: number
      readonly tools: readonly string[]
      readonly estimatedTokens?: number
      readonly thresholdTokens?: number
      readonly pruned?: number
      readonly compacted?: boolean
      /**
       * The surface generation this request was built at.
       *
       * It is what makes a provider's reported usage reusable: a usage number describes one
       * envelope, so it may only anchor a measurement of that same envelope. A later append or
       * replacement moves the generation, and the number stops applying.
       */
      readonly generation?: number
    },
  ): void {
    this.append(handle, { type: 'model/request', ...request })
  }

  /**
   * The messages a resumed session would send.
   *
   * Derived from the surface rather than filtered from the log, so a compaction or a pruning is
   * reflected here: this is the model's view, and `read()` remains the human's.
   */
  messages(handle: SessionHandle): readonly RecordedMessage[] {
    return this.deriveMessages(handle)
  }

  /** The plain text of a session's last assistant answer. */
  lastAnswer(handle: SessionHandle): string {
    const events = this.read(handle)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'assistant/completed') return String(event.text ?? '')
    }
    return ''
  }

  private bumpTurns(handle: SessionHandle): void {
    const path = join(handle.dir, 'meta.json')
    try {
      const meta = JSON.parse(readFileSync(path, 'utf8')) as SessionMeta
      const updated: SessionMeta = { ...meta, turns: (meta.turns ?? 0) + 1 }
      writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`)
    } catch {
      // A session without readable metadata is still a usable session; the count
      // is a convenience and losing it must not lose the turn.
    }
  }
}
