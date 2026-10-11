import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type { ContentPart, Message, ToolSpec } from '../llm/types.ts'
import type { RecordedMessage, SessionEvent, SessionHandle, SessionStore } from '../session/store.ts'

/**
 * Context assembly, pruning and compaction.
 *
 * Modelled on `@deepseek-ai/dsh-*`'s arrangement, and the parts worth naming are the
 * ones that surprised me:
 *
 * - **A token meter is separate from the assembler, and it is a heuristic.** DSH
 *   estimates at four characters per token plus fixed per-message and per-block
 *   overhead, and only reuses provider usage when it is for the same request shape and
 *   no smaller than the estimate. So this does the same: the estimate is what decides
 *   the budget, and the provider's number is a cross-check.
 * - **Compaction appends, it does not rewrite.** DSH records `compaction/start`,
 *   `compaction/summary`, then a user message carrying a `surfaceOp: replace` and
 *   finally `compaction/end`; the shadowed events stay in the log, so a replay is
 *   exact. Here the same: the log keeps every message, and the *assembly* honours the
 *   `compaction/summary` events it finds.
 * - **Pruning comes before compaction.** A tool result larger than the prune budget is
 *   cut to head plus marker plus tail first, because trimming one huge result is
 *   cheaper in meaning than summarising twenty small ones.
 * - **The budget is a ratio of the context window.** DSH uses `thresholdRatio = 0.8`
 *   and `retainRatio = 0.16`; both are kept here, with the same requirement that
 *   retention is below the threshold.
 */

/** Four characters per token, the same heuristic DSH uses when it has no count. */
export const CHARS_PER_TOKEN = 4
/** Fixed overhead per message and per content block, in estimated tokens. */
export const ROLE_OVERHEAD = 4
export const BLOCK_OVERHEAD = 4
/** Compact when the estimate reaches this fraction of the window. */
export const THRESHOLD_RATIO = 0.8
/** Keep this fraction of the window as recent history, uncompacted. */
export const RETAIN_RATIO = 0.16
/** A tool result longer than this is pruned, in characters. */
export const PRUNE_THRESHOLD_CHARS = 8192
export const PRUNE_HEAD_CHARS = 4096
export const PRUNE_TAIL_CHARS = 1024
export const PRUNE_MARKER = '\n… [pruned, N characters removed] …\n'
/** The largest instruction file that is read whole. */
export const INSTRUCTIONS_MAX_BYTES = 65536

/** What an assembly was made of, for a caller that wants to report or check it. */
export interface ContextReport {
  readonly messages: readonly Message[]
  readonly estimatedTokens: number
  readonly contextWindow: number
  readonly thresholdTokens: number
  readonly pruned: number
  readonly compacted: boolean
  readonly instructions: readonly string[]
}

/** Estimate one content part. */
export function estimatePart(part: ContentPart): number {
  const text = part.type === 'tool-call' ? `${part.name}${part.arguments}` : part.text
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/** Estimate one message. */
export function estimateMessage(message: Message): number {
  return ROLE_OVERHEAD + message.content.reduce((total, part) => total + estimatePart(part), 0)
}

/** Estimate a whole request's messages. */
export function estimateMessages(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessage(message), 0)
}

/**
 * A tool result longer than the budget, cut to head and tail.
 *
 * The marker records how much was removed, because a reader who sees a truncated
 * result needs to know whether a little or most of it is missing.
 */
export function pruneText(text: string, threshold = PRUNE_THRESHOLD_CHARS): { text: string; pruned: boolean } {
  if (text.length <= threshold) return { text, pruned: false }
  const head = text.slice(0, PRUNE_HEAD_CHARS)
  const tail = text.slice(-PRUNE_TAIL_CHARS)
  const removed = text.length - head.length - tail.length
  return { text: `${head}${PRUNE_MARKER.replace('N', String(removed))}${tail}`, pruned: true }
}

/**
 * Read the instruction files that apply to a working directory.
 *
 * DSH's rule, kept because it is the right one: walk from the repository root (the
 * nearest ancestor with a `.git`) down to the working directory, reading `AGENTS.md`
 * and `CLAUDE.md` at each level, broadest first. A file over the budget is dropped
 * before the most specific one is truncated, because the nearest file is the one that
 * knows about this directory.
 */
export function findInstructions(cwd: string, options: { readonly maxBytes?: number } = {}): readonly { path: string; text: string }[] {
  const maxBytes = options.maxBytes ?? INSTRUCTIONS_MAX_BYTES
  const chain: string[] = []
  let current = resolve(cwd)
  for (;;) {
    chain.push(current)
    const parent = resolve(current, '..')
    if (parent === current) break
    // Stop at the repository root, which is what makes this per-project rather than
    // per-machine.
    try {
      readFileSync(join(current, '.git'), 'utf8')
      break
    } catch {
      // a `.git` directory rather than a file is the usual case
      try {
        if (readFileSync(join(current, '.git', 'HEAD'), 'utf8').length > 0) break
      } catch {
        // keep walking
      }
    }
    current = parent
  }

  const found: { path: string; text: string }[] = []
  for (const dir of [...chain].reverse()) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = join(dir, name)
      try {
        const text = readFileSync(path, 'utf8')
        found.push({ path, text })
      } catch {
        continue
      }
    }
  }
  // Drop from the broad end until the whole set fits, then truncate the last one.
  let total = found.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0)
  while (found.length > 1 && total > maxBytes) {
    const dropped = found.shift()
    total -= dropped === undefined ? 0 : Buffer.byteLength(dropped.text)
  }
  const last = found[found.length - 1]
  if (last !== undefined && Buffer.byteLength(last.text) > maxBytes) {
    const truncated = Buffer.from(last.text).subarray(0, maxBytes).toString('utf8')
    found[found.length - 1] = { path: last.path, text: `${truncated}\n… [truncated to ${maxBytes} bytes]` }
  }
  return found
}

/** What the assembler needs to build one request's context. */
export interface AssembleOptions {
  readonly session: SessionHandle
  /** The system prompt, if the caller has one. */
  readonly system?: string
  /** The working directory to read instructions from. */
  readonly cwd: string
  /** The tools the request carries, so their schemas count against the budget. */
  readonly tools?: readonly ToolSpec[]
  /** The model's context window in tokens. */
  readonly contextWindow: number
  /** Override the compaction threshold, for a check that must trigger it quickly. */
  readonly thresholdTokens?: number
  /** Read instruction files at all; off for a check that does not want them. */
  readonly instructions?: boolean
}

/**
 * Build one model call's messages from a session.
 *
 * The order is DSH's order, and it matters:
 *
 * 1. the system prompt, as the first message;
 * 2. project instructions, as a user message after it;
 * 3. the history this session recorded, with any `compaction/summary` event's
 *    replacement applied;
 * 4. pruning of oversized tool results, before anything is summarised.
 *
 * Compaction is decided here rather than in the loop because the budget is a property
 * of the assembled request, not of the turn.
 */
export class ContextAssembler {
  /**
   * Held as a field rather than a constructor parameter property, because this
   * project compiles with `erasableSyntaxOnly`. Measured by the compiler.
   */
  private readonly store: SessionStore

  constructor(store: SessionStore) {
    this.store = store
  }

  /** Assemble, and say what was done. */
  assemble(options: AssembleOptions): ContextReport {
    const events = this.store.read(options.session)
    const thresholdTokens = options.thresholdTokens ?? Math.floor(options.contextWindow * THRESHOLD_RATIO)

    const files = options.instructions === false ? [] : findInstructions(options.cwd)
    const readPaths = files.map((entry) => entry.path)
    const instructions = files.map((entry) => `# ${entry.path}\n\n${entry.text}`)

    const head: Message[] = []
    if (options.system !== undefined && options.system.length > 0) {
      head.push({ role: 'system', content: [{ type: 'text', text: options.system }] })
    }
    for (const text of instructions) {
      head.push({ role: 'user', content: [{ type: 'text', text }] })
    }

    // The newest compaction summary, if any, replaces everything before it.
    const summary = [...events].reverse().find((event) => event.type === 'compaction/summary')
    const replacement = summary?.summary as string | undefined
    const startSeq = replacement === undefined ? 0 : Number(summary?.throughSeq ?? 0) + 1
    const history = events.filter((event) => event.seq >= startSeq)

    const messages: Message[] = [...head]
    if (replacement !== undefined) {
      messages.push({ role: 'user', content: [{ type: 'text', text: replacement }] })
    }

    let pruned = 0
    for (const message of project(history)) {
      if (message.role === 'tool') {
        const next = message.content.map((part) => {
          if (part.type !== 'text') return part
          const result = pruneText(part.text)
          if (result.pruned) pruned += 1
          return { type: 'text' as const, text: result.text }
        })
        messages.push({ ...message, content: next })
      } else {
        messages.push(message)
      }
    }

    return {
      messages,
      estimatedTokens: estimateMessages(messages),
      contextWindow: options.contextWindow,
      thresholdTokens,
      pruned,
      compacted: replacement !== undefined,
      instructions: readPaths,
    }
  }

  /**
   * Whether this session is over its budget, and what to compact if so.
   *
   * Returns the seq range to shadow and the messages to summarise. The tail kept
   * uncompacted is `RETAIN_RATIO` of the window, so the summary never has to carry the
   * most recent exchange — which is the part a model needs verbatim.
   */
  plan(options: {
    readonly session: SessionHandle
    readonly contextWindow: number
    readonly thresholdTokens?: number
  }): { readonly needed: boolean; readonly fromSeq?: number; readonly throughSeq?: number; readonly retainedSeq?: number; readonly estimatedTokens: number } {
    const thresholdTokens = options.thresholdTokens ?? Math.floor(options.contextWindow * THRESHOLD_RATIO)
    const events = this.store.read(options.session)
    const summary = [...events].reverse().find((event) => event.type === 'compaction/summary')
    const startSeq = summary === undefined ? 0 : Number(summary.throughSeq ?? 0) + 1
    const considered = events.filter((event) => event.seq >= startSeq)
    const messages = project(considered)
    const estimatedTokens = estimateMessages(messages)
    if (estimatedTokens < thresholdTokens) return { needed: false, estimatedTokens }

    const retainTokens = Math.floor(options.contextWindow * RETAIN_RATIO)
    const retained: Message[] = []
    let retainedTokens = 0
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message === undefined) continue
      const cost = estimateMessage(message)
      if (retainedTokens + cost > retainTokens) break
      retained.unshift(message)
      retainedTokens += cost
    }
    const shadowedCount = messages.length - retained.length
    const shadowed = considered.filter((event) => event.type === 'message').slice(0, shadowedCount)
    const first = shadowed[0]
    const last = shadowed[shadowed.length - 1]
    if (first === undefined || last === undefined) return { needed: false, estimatedTokens }

    return {
      needed: true,
      fromSeq: first.seq,
      throughSeq: last.seq,
      retainedSeq: retained.length,
      estimatedTokens,
    }
  }
}

/**
 * Turn session events into the messages a model reads.
 *
 * Chunks are folded into the message they belong to rather than recorded as messages
 * of their own: DSH settles a stream into one `assistant/message` event, while this
 * records each chunk as it arrives so an interrupted turn is not lost. The fold is
 * where those two choices meet, and it is why this is a projection rather than a
 * property of the store.
 */
export function project(events: readonly SessionEvent[]): readonly Message[] {
  const messages: Message[] = []
  let pendingAssistant: { content: ContentPart[] } | null = null

  const settle = () => {
    if (pendingAssistant === null) return
    if (pendingAssistant.content.length > 0) {
      messages.push({ role: 'assistant', content: [...pendingAssistant.content] })
    }
    pendingAssistant = null
  }

  for (const event of events) {
    if (event.type === 'message') {
      settle()
      const message = event.message as RecordedMessage | undefined
      if (message !== undefined) {
        messages.push({
          role: message.role,
          content: [...message.content],
          ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
        })
      }
      continue
    }
    if (event.type !== 'assistant/chunk') continue
    const chunk = event.chunk as { type: string; text?: string; id?: string; name?: string; arguments?: string } | undefined
    if (chunk === undefined) continue
    pendingAssistant ??= { content: [] }
    if (chunk.type === 'text-delta' && chunk.text !== undefined) {
      pendingAssistant.content.push({ type: 'text', text: chunk.text })
    } else if (chunk.type === 'reasoning-delta' && chunk.text !== undefined) {
      // Reasoning is a first-class block, as it is in DSH, so a provider that accepts
      // it back can be given it.
      pendingAssistant.content.push({ type: 'reasoning', text: chunk.text })
    } else if (chunk.type === 'tool-call' && chunk.name !== undefined) {
      pendingAssistant.content.push({
        type: 'tool-call',
        id: chunk.id ?? `call-${chunk.name}`,
        name: chunk.name,
        arguments: chunk.arguments ?? '{}',
      })
    } else if (chunk.type === 'done') {
      settle()
    }
  }
  settle()
  return messages
}

/**
 * The prompt that asks a model to summarise a span of its own conversation.
 *
 * Written as DSH writes its equivalent: the instruction is the last user message, and
 * the span being summarised leads it, so a provider's prefix cache can be reused.
 */
export const COMPACTION_INSTRUCTION = [
  'Summarise the conversation above so it can continue without the original messages.',
  'Keep every decision, constraint, file path, command and result that still matters.',
  'Keep unresolved questions and what was tried. Drop greetings and repetition.',
  'Write it as a briefing to yourself, not as a reply to the user.',
].join(' ')
