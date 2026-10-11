/**
 * The Trajectory ledger: one session's recorded events, projected as a turn-aware ledger.
 *
 * This is the same idea DSH's `dsh-client-ui-trajectory` states plainly — its view is a **pure projection**
 * of the session window and "neither reads nor changes the Chat conversation snapshot". Two views over one
 * record cannot disagree about what happened; two stores can. So this file reads events and returns data,
 * and the page decides how to draw it.
 *
 * What the ledger is for: the Chat view answers *what was said*, and this answers *what the harness did* —
 * which step, in which turn, how long it took, and what it cost. The chat view deliberately collapses the
 * parts (reasoning, tool arguments) that a reader wants out of the way; the ledger is where they are the
 * subject rather than the interruption.
 *
 * Three rules are copied from DSH because each is a way to lie to a reader:
 *
 * - **An in-flight record has a start and no duration.** A duration for something still running is invented
 *   time, and it is the kind a reader believes.
 * - **An unavailable number is absent, not zero.** `inputTokens: 0` says a request cost nothing, which is a
 *   different and false claim from "this was not reported".
 * - **A record's timing comes from its own events.** Nothing interpolates a missing timestamp.
 */

/** One event, as much of it as the projection reads. */
export interface LedgerEvent {
  readonly seq?: number
  readonly at?: string
  readonly type: string
  readonly message?: { readonly role?: string; readonly content?: readonly { readonly type?: string; readonly text?: string }[]; readonly toolCallId?: string }
  readonly chunk?: { readonly type?: string; readonly id?: string; readonly name?: string; readonly arguments?: string; readonly text?: string; readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number } }
  readonly text?: string
  readonly reasoning?: string
  readonly finishReason?: string
  readonly rounds?: number
  readonly messages?: number
  readonly estimatedTokens?: number
  readonly pruned?: number
  readonly compacted?: boolean
  readonly endpoint?: string
  readonly model?: string
  /** The tools the request offered, when it recorded them. */
  readonly tools?: readonly string[]
}

/** What produced a record. The vocabulary is DSH's, so a reader of either tool sees the same words. */
export type LedgerKind = 'user' | 'assistant' | 'tool' | 'reasoning' | 'system' | 'compaction'

/** One row of the ledger. */
export interface LedgerRecord {
  readonly kind: LedgerKind
  /** A one-line identity: the tool's name, the model, or the record's kind. */
  readonly label: string
  /** The full text — the tool's arguments, the reasoning, or the message. */
  readonly text: string
  /** When it started, from its own event. Absent when the event carried no time. */
  readonly startedAt?: string
  /**
   * How long it took, in milliseconds.
   *
   * Absent while the record is still running, and absent when the events cannot measure it. The two are
   * distinguished by `inFlight`: a reader deserves to know which it is.
   */
  readonly durationMs?: number
  /**
   * Whether the record had not finished when these events ended.
   *
   * True for a chunk stream with no settling event after it — a killed run, or one still arriving. It is the
   * field that stops a caller printing a duration for something unfinished.
   */
  readonly inFlight?: boolean
  /** Time to first token, when a stream recorded one and a step start is known. */
  readonly ttftMs?: number
  /** Token counts, each absent rather than zero when the record does not carry one. */
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
  /** Whether the counts came from the provider rather than from the harness's own estimate. */
  readonly usageSource?: 'provider' | 'estimated'
  /** Whatever else the event said that a reader would want: finish reason, denials, pruned count. */
  readonly note?: string
}

/** A step: one model request and everything it produced. */
export interface LedgerStep {
  readonly index: number
  readonly records: readonly LedgerRecord[]
  /** The model this step asked, when the request named one. */
  readonly model?: string
  readonly startedAt?: string
  readonly durationMs?: number
}

/** A turn: what one prompt caused, in steps. */
export interface LedgerTurn {
  readonly index: number
  readonly startedAt?: string
  readonly durationMs?: number
  readonly rounds?: number
  readonly steps: readonly LedgerStep[]
}

/** The whole ledger, plus the totals a header shows. */
export interface Ledger {
  readonly turns: readonly LedgerTurn[]
  /** Records that belong to no turn — a session that recorded events before the first prompt. */
  readonly loose: readonly LedgerRecord[]
  readonly tokens: { readonly input?: number; readonly output?: number; readonly estimated?: number }
  readonly records: number
  readonly inFlight: number
}

/** Milliseconds between two timestamps, or `undefined` when either is missing or the pair is backwards. */
function between(from?: string, to?: string): number | undefined {
  if (from === undefined || to === undefined) return undefined
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined
  return end - start
}

/** A chunk stream that is being assembled into one assistant record. */
interface PendingAssistant {
  parts: string[]
  reasoning: string[]
  startedAt?: string
  firstTokenAt?: string
  inputTokens?: number
  outputTokens?: number
  sawProviderUsage: boolean
}

/**
 * Project events into the ledger.
 *
 * Pure: the same events always give the same ledger, and nothing here writes or mutates its input. The
 * caller decides what to render, including how much of a long record to show.
 */
export function projectLedger(events: readonly LedgerEvent[]): Ledger {
  const turns: LedgerTurn[] = []
  const loose: LedgerRecord[] = []
  let turn: { index: number; startedAt?: string; endedAt?: string; rounds?: number; steps: LedgerStep[] } | null = null
  /**
   * Records that belong to the current turn but precede its first step.
   *
   * The prompt is the turn's opener, not part of any request, and the first `model/request` is what opens
   * step one. Keeping the prompt here and folding it into that step is what stops it being dropped — the
   * first version pushed it into a step the request then replaced, and the prompt vanished.
   */
  let prologue: LedgerRecord[] = []
  let step: { startedAt?: string; endedAt?: string; model?: string; records: LedgerRecord[] } | null = null
  let pending: PendingAssistant | null = null

  const tokens = { input: undefined as number | undefined, output: undefined as number | undefined, estimated: undefined as number | undefined }

  /**
   * Close the open step.
   *
   * `keepPrologue` is the subtlety, and getting it wrong cost two rounds of tests. When a `model/request`
   * arrives, the prompt that opened the turn must **not** be flushed into a step of its own: it belongs to
   * the step the request is about to open, and the first version therefore produced one step holding the
   * prompt and another holding everything else. At a turn boundary the prologue has nowhere left to go, so
   * it is folded in.
   */
  const closeStep = (at?: string, keepPrologue = false): void => {
    const records = step?.records ?? []
    const startedAt = step?.startedAt
    const model = step?.model
    const endedAt = step?.endedAt ?? at
    step = null
    if (records.length === 0 && prologue.length === 0) {
      prologue = []
      return
    }
    const duration = between(startedAt, endedAt)
    if (records.length === 0) {
      /** Nothing but a prompt so far: it waits for the step that will hold it. */
      if (!keepPrologue) {
        turn?.steps.push({ index: (turn?.steps.length ?? 0) + 1, records: prologue, ...(prologue[0]?.startedAt !== undefined ? { startedAt: prologue[0].startedAt } : {}) })
        prologue = []
      }
      return
    }
    turn?.steps.push({
      index: (turn?.steps.length ?? 0) + 1,
      records: [...prologue, ...records],
      ...(model !== undefined ? { model } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
    })
    if (!keepPrologue) prologue = []
  }

  /** Close the current turn, if there is one. */
  const closeTurn = (at?: string, rounds?: number): void => {
    closeStep(at)
    if (prologue.length > 0) closeStep(at)
    if (turn === null) return
    const end = at ?? turn.endedAt
    turns.push({
      index: turn.index,
      steps: turn.steps,
      ...(turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}),
      ...(between(turn.startedAt, end) !== undefined ? { durationMs: between(turn.startedAt, end) } : {}),
      ...(turn.rounds !== undefined ? { rounds: turn.rounds } : rounds !== undefined ? { rounds } : {}),
    })
    turn = null
  }

  /** Where a record goes: the open step, or the turn's prologue. */
  const put = (record: LedgerRecord): void => {
    if (step !== null) step.records.push(record)
    else if (turn !== null) prologue.push(record)
    else loose.push(record)
  }

  /** Close an in-flight assistant stream. `settled` decides whether it gets a duration or is marked running. */
  const settleAssistant = (at?: string, settled = false): void => {
    if (pending === null) return
    const text = pending.parts.join('')
    const reasoning = pending.reasoning.join('')
    const ttft = between(pending.startedAt, pending.firstTokenAt)
    if (reasoning.length > 0) {
      put({ kind: 'reasoning', label: 'reasoning', text: reasoning, ...(pending.startedAt !== undefined ? { startedAt: pending.startedAt } : {}) })
    }
    if (text.length > 0 || pending.inputTokens !== undefined || pending.outputTokens !== undefined) {
      put({
        kind: 'assistant',
        label: 'assistant',
        text,
        ...(pending.startedAt !== undefined ? { startedAt: pending.startedAt } : {}),
        ...(settled && at !== undefined && between(pending.startedAt, at) !== undefined ? { durationMs: between(pending.startedAt, at) } : {}),
        ...(!settled ? { inFlight: true } : {}),
        ...(ttft !== undefined ? { ttftMs: ttft } : {}),
        /**
         * Usage is attached only when there is something to attach. A record with no reported tokens carries no
         * `usage` key at all, so a renderer cannot mistake "not reported" for "zero".
         */
        ...(pending.inputTokens !== undefined || pending.outputTokens !== undefined
          ? {
              usage: {
                ...(pending.inputTokens !== undefined ? { inputTokens: pending.inputTokens } : {}),
                ...(pending.outputTokens !== undefined ? { outputTokens: pending.outputTokens } : {}),
              },
              usageSource: pending.sawProviderUsage ? ('provider' as const) : ('estimated' as const),
            }
          : {}),
      })
    }
    pending = null
  }

  for (const event of events) {
    if (event.type === 'message') {
      const role = event.message?.role
      const text = (event.message?.content ?? []).map((part) => part.text ?? '').join('')
      if (role === 'user') {
        settleAssistant(event.at, true)
        closeTurn(event.at)
        turn = { index: turns.length + 1, startedAt: event.at, steps: [] }
        prologue = [{ kind: 'user', label: 'user', text, ...(event.at !== undefined ? { startedAt: event.at } : {}) }]
        continue
      }
      if (role === 'tool') {
        const refused = /^error/i.test(text)
        put({
          kind: 'tool',
          label: refused ? 'tool (refused)' : 'tool result',
          text,
          ...(event.at !== undefined ? { startedAt: event.at } : {}),
          ...(refused ? { note: 'the tool refused this call' } : {}),
        })
        continue
      }
      if (role === 'assistant') {
        settleAssistant(event.at, true)
        put({ kind: 'assistant', label: 'assistant', text, ...(event.at !== undefined ? { startedAt: event.at } : {}) })
        continue
      }
      continue
    }

    if (event.type === 'session/created') continue

    if (event.type === 'model/request') {
      settleAssistant(event.at, true)
      /** The prompt waits for this step, which is the one it belongs to. */
      closeStep(event.at, true)
      step = { startedAt: event.at, records: [], ...(event.model !== undefined ? { model: event.model } : {}) }
      if (event.estimatedTokens !== undefined) {
        tokens.estimated = (tokens.estimated ?? 0) + event.estimatedTokens
        put({
          kind: 'system',
          label: 'request',
          text: [
            `${event.messages ?? '?'} message(s)`,
            event.tools !== undefined ? `tools: ${event.tools.join(', ')}` : undefined,
            event.endpoint !== undefined ? `endpoint: ${event.endpoint}` : undefined,
            event.pruned !== undefined && event.pruned > 0 ? `pruned: ${event.pruned}` : undefined,
            event.compacted === true ? 'compacted: yes' : undefined,
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
          ...(event.at !== undefined ? { startedAt: event.at } : {}),
          usage: { inputTokens: event.estimatedTokens },
          usageSource: 'estimated',
        })
      }
      continue
    }

    if (event.type === 'assistant/chunk') {
      const chunk = event.chunk
      if (chunk === undefined) continue
      pending ??= { parts: [], reasoning: [], ...(event.at !== undefined ? { startedAt: event.at } : {}), sawProviderUsage: false }
      /** The first token of the stream, which is what TTFT measures from the step start to. */
      pending.firstTokenAt ??= event.at
      if (chunk.type === 'text-delta' && chunk.text !== undefined) pending.parts.push(chunk.text)
      else if (chunk.type === 'reasoning-delta' && chunk.text !== undefined) pending.reasoning.push(chunk.text)
      else if (chunk.type === 'tool-call' && chunk.name !== undefined) {
        settleAssistant(event.at, true)
        put({ kind: 'tool', label: `→ ${chunk.name}`, text: chunk.arguments ?? '{}', ...(event.at !== undefined ? { startedAt: event.at } : {}) })
      }
      /**
       * Provider usage, when the provider reported it. This is the truth the estimate approximates, and the
       * ledger marks which it holds rather than presenting one as the other.
       *
       * Read **before** a `done` chunk settles the record, and that order is the whole point: the first
       * version settled on `done` and then read the usage, so the provider's numbers were dropped on the
       * floor for every provider that reports them with the last chunk — which is how they are normally
       * reported. Measured, and it read as `undefined` rather than as an error until a `done` chunk carried
       * usage and the code wrote to a record that had already been closed.
       */
      if (pending !== null && (chunk.usage?.inputTokens !== undefined || chunk.usage?.outputTokens !== undefined)) {
        pending.sawProviderUsage = true
        if (chunk.usage.inputTokens !== undefined) {
          pending.inputTokens = chunk.usage.inputTokens
          tokens.input = (tokens.input ?? 0) + chunk.usage.inputTokens
        }
        if (chunk.usage.outputTokens !== undefined) {
          pending.outputTokens = chunk.usage.outputTokens
          tokens.output = (tokens.output ?? 0) + chunk.usage.outputTokens
        }
      }
      if (chunk.type === 'done') settleAssistant(event.at, true)
      continue
    }

    if (event.type === 'assistant/completed') {
      settleAssistant(event.at, true)
      const notes = [
        event.finishReason !== undefined ? `finish: ${event.finishReason}` : undefined,
        event.rounds !== undefined ? `rounds: ${event.rounds}` : undefined,
      ].filter((line): line is string => line !== undefined)
      if (notes.length > 0) put({ kind: 'system', label: 'completed', text: notes.join('\n'), ...(event.at !== undefined ? { startedAt: event.at } : {}) })
      if (step !== null) step.endedAt = event.at
      continue
    }

    if (event.type === 'turn/retry') {
      put({ kind: 'system', label: 'retry', text: 'this step was retried', ...(event.at !== undefined ? { startedAt: event.at } : {}) })
      continue
    }

    if (event.type === 'turn/completed') {
      settleAssistant(event.at, true)
      closeTurn(event.at, event.rounds)
      continue
    }

    /**
     * Anything else is a record without a home yet, kept rather than dropped: a ledger that silently ignores
     * events it does not recognise cannot be trusted to be complete.
     */
    put({ kind: 'system', label: event.type, text: JSON.stringify(event).slice(0, 400), ...(event.at !== undefined ? { startedAt: event.at } : {}) })
  }

  /**
   * The tail is left open deliberately: a caller projecting a session that is still running must see the
   * unfinished stream as unfinished, which `settleAssistant(undefined, false)` is what marks.
   */
  settleAssistant(undefined, false)
  closeTurn()

  const all = [...turns.flatMap((item) => item.steps.flatMap((entry) => entry.records)), ...loose]
  return {
    turns,
    loose,
    tokens: {
      ...(tokens.input !== undefined ? { input: tokens.input } : {}),
      ...(tokens.output !== undefined ? { output: tokens.output } : {}),
      ...(tokens.estimated !== undefined ? { estimated: tokens.estimated } : {}),
    },
    records: all.length,
    inFlight: all.filter((record) => record.inFlight === true).length,
  }
}
