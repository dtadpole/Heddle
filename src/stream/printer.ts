import type { Context } from '@deepseek-ai/cordis'

import type { Chunk } from '../llm/types.ts'
import type { SessionEvent } from '../session/store.ts'

/**
 * A streaming view on standard error.
 *
 * This is the harness's own proof that streaming works **without a browser**: the same
 * `session/event` the Web UI subscribes to is written to a terminal line by line as it
 * is appended, so `heddle --stream` shows a model's reasoning and answer arriving while
 * it is still writing. It exists as a first-class surface rather than as a debugging
 * leftover because the streaming claim must be judgeable on its own — a claim that can
 * only be checked through a UI is a claim that breaks whenever the UI does.
 *
 * Deliberately on **stderr** while the final answer goes to stdout: a consumer piping the
 * answer should not have to strip a live transcript out of it, and both are visible in a
 * terminal.
 */

export interface StreamPrinterOptions {
  /** The session to show; other sessions' events are ignored. */
  readonly session: string
  /** Where to write. Defaults to `process.stderr`. */
  readonly write?: (text: string) => void
  /** Include reasoning deltas, which is on by default. */
  readonly reasoning?: boolean
  /** Include tool-call lines. */
  readonly tools?: boolean
}

/** What the printer saw, so a caller can assert the stream really carried content. */
export interface StreamSummary {
  readonly textDeltas: number
  readonly reasoningDeltas: number
  readonly toolCalls: number
  /** Milliseconds from the first delta to the last, which is what "live" means. */
  readonly spanMs: number
  readonly completed: boolean
}

/**
 * Print one session's stream as it happens.
 *
 * Returns the disposer and a function that reports what was printed. The disposer is
 * what makes this owned: registered through `ctx.on`, it is released with the fiber that
 * registered it, which is the Cordis rule every hook here follows.
 */
export function printStream(ctx: Context, options: StreamPrinterOptions): { dispose: () => void; summary: () => StreamSummary } {
  const write = options.write ?? ((text: string) => process.stderr.write(text))
  const reasoning = options.reasoning ?? true
  const tools = options.tools ?? true

  let textDeltas = 0
  let reasoningDeltas = 0
  let toolCalls = 0
  let first: number | undefined
  let last: number | undefined
  let completed = false

  const onEvent = (payload: { session: string; event: SessionEvent }) => {
    if (payload.session !== options.session) return
    const event = payload.event
    const now = Date.now()

    if (event.type === 'assistant/chunk') {
      const chunk = event.chunk as Chunk | undefined
      if (chunk === undefined) return
      if (chunk.type === 'reasoning-delta') {
        if (!reasoning) return
        reasoningDeltas += 1
        first ??= now
        last = now
        write(`\u001b[2m[reasoning] ${chunk.text}\u001b[0m`)
      } else if (chunk.type === 'text-delta') {
        textDeltas += 1
        first ??= now
        last = now
        write(chunk.text)
      } else if (chunk.type === 'tool-call') {
        if (!tools) return
        toolCalls += 1
        first ??= now
        last = now
        write(`\n[tool] ${chunk.name} ${chunk.arguments}\n`)
      }
      return
    }

    if (event.type === 'assistant/completed') {
      completed = true
      write('\n')
      return
    }

    if (event.type === 'message' && event.message !== undefined) {
      const message = event.message as { role: string; content: { type: string; text?: string }[] }
      const text = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('')
      if (text.length === 0) return
      if (message.role === 'user') write(`\n[user] ${text}\n`)
      if (message.role === 'tool') write(`[tool result] ${text}\n`)
    }
  }

  const dispose = ctx.on('session/event', onEvent)
  return {
    dispose: () => {
      if (typeof dispose === 'function') dispose()
    },
    summary: () => ({
      textDeltas,
      reasoningDeltas,
      toolCalls,
      spanMs: first === undefined || last === undefined ? 0 : last - first,
      completed,
    }),
  }
}
