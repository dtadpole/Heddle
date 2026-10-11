import type { ContentPart, Message } from '../llm/types.ts'
import type { SessionHandle } from '../session/store.ts'

import { estimateMessage } from './meter.ts'

/**
 * Durable tool-result pruning.
 *
 * Modelled on `@deepseek-ai/dsh-compaction-tool-result-pruner`, and the one structural
 * difference from what this harness did before is the point of the module: pruning here
 * is a **surface rewrite**, not a temporary edit made while assembling a request.
 * `ContextAssembler.assemble` used to trim an oversized tool result on every call and
 * record nothing, so the log and what the model saw disagreed. Now a pruned result is a
 * new event in the append-only log whose `surfaceOp` shadows the original, immediately
 * preceded by a log-only `compaction/prune` event carrying its shadow price; the original
 * stays in the log, so a transcript still shows what the tool really returned.
 *
 * The facts below were read off DSH 0.2.0-rc.2, and the ones worth naming are the ones
 * that look like they could be improved and must not be:
 *
 * - **The surface is walked in order, and the budget is per result.** DSH takes one
 *   stable snapshot of `session.surface.nodes` and prunes every over-budget result in
 *   that order. There is no ranking, no sort and no "worst first", and the threshold is
 *   compared against one result's own text rather than a sum across results. Ranking
 *   looks like an obvious improvement and is not what the system being mirrored does,
 *   so it is deliberately absent.
 * - **Non-text blocks are never dropped.** DSH rewrites text and passes every rich block
 *   through in its original relative order and position, because block order is what a
 *   provider replays.
 * - **The shadow price is logged before the replacement it prices.** DSH appends
 *   `compaction/prune` pricing the *original* through the token meter, then the
 *   replacement, so a pure consumer can subtract the shadowed cost without holding
 *   per-node state.
 * - **A result that cannot shrink is not replaced.** The validated head + marker + tail
 *   budget is what guarantees a replacement is smaller than its input, and the
 *   "nothing actually changed" check is what keeps a second pass over an already-pruned
 *   surface from appending anything.
 */

/** A tool result longer than this is pruned, in characters. */
export const PRUNE_THRESHOLD_CHARS = 8192
/** How many characters of a pruned result's start are kept. */
export const PRUNE_HEAD_CHARS = 4096
/** How many characters of a pruned result's end are kept. */
export const PRUNE_TAIL_CHARS = 1024
/**
 * What replaces a pruned result's middle, with `N` standing for the count removed.
 *
 * The marker records how much was removed, because a reader who sees a truncated
 * result needs to know whether a little or most of it is missing. Its template length
 * is what the head/tail budget is validated against, as in DSH: the digits `N` becomes
 * are not known until a result is pruned, and the invariant only has to hold for the
 * shape that is actually emitted.
 */
export const PRUNE_MARKER = '\n… [pruned, N characters removed] …\n'

/** The three character budgets that decide when a result is pruned and how. */
export interface PruneConfig {
  /** A result whose text is longer than this is pruned, in characters. */
  readonly thresholdChars: number
  /** How much of the start is kept. */
  readonly headChars: number
  /** How much of the end is kept. */
  readonly tailChars: number
}

/**
 * Fill a partial budget out to a whole one.
 *
 * A caller overrides one number and leaves the rest to DSH's defaults, which is the
 * shape the plugin configuration has there too.
 */
function resolvePruneConfig(config: Partial<PruneConfig>): PruneConfig {
  return {
    thresholdChars: config.thresholdChars ?? PRUNE_THRESHOLD_CHARS,
    headChars: config.headChars ?? PRUNE_HEAD_CHARS,
    tailChars: config.tailChars ?? PRUNE_TAIL_CHARS,
  }
}

/** Sum the characters of a message's text parts; non-text blocks are not measured, as in DSH. */
function measureText(parts: readonly ContentPart[]): number {
  let total = 0
  for (const part of parts) if (part.type === 'text') total += part.text.length
  return total
}

/**
 * A tool result longer than the budget, cut to head and tail.
 *
 * Kept as this harness had it: the test is `text.length <= thresholdChars`, so a result
 * exactly at the threshold is untouched, and the replacement is `head + marker + tail`
 * with the marker naming the characters removed. Measuring in UTF-16 code units rather
 * than DSH's code points is the one deliberate difference — it is what the rest of this
 * harness counts, and a boundary inside a surrogate pair is a character the model would
 * not have understood anyway.
 */
export function pruneText(text: string, config: Partial<PruneConfig> = {}): { readonly text: string; readonly pruned: boolean } {
  const { thresholdChars, headChars, tailChars } = resolvePruneConfig(config)
  if (text.length <= thresholdChars) return { text, pruned: false }
  const head = text.slice(0, headChars)
  // `slice(-0)` is `slice(0)`, the whole string, so an empty tail is spelled out.
  const tail = tailChars === 0 ? '' : text.slice(-tailChars)
  const removed = text.length - head.length - tail.length
  return { text: `${head}${PRUNE_MARKER.replace('N', String(removed))}${tail}`, pruned: true }
}

/**
 * The store operations pruning needs, declared here rather than imported.
 *
 * `SessionStore` is being extended in the same change that adds this module, and a
 * structural interface keeps pruning testable on its own — an in-memory fake is three
 * methods, and the real store still satisfies this without either file naming the other.
 */
export interface PrunableStore {
  /** The surface, in order: the seq of every node the model can see. */
  surface(handle: SessionHandle): { readonly nodes: readonly number[] }
  /** A node's derived message, or null when the node produces none. */
  deriveNode(handle: SessionHandle, seq: number): Message | null
  /** Append an event; `surfaceOp` 'replace' shadows the range `startSeq..endSeq`. */
  append(
    handle: SessionHandle,
    event: { readonly type: string; readonly [key: string]: unknown },
    options?: { readonly surfaceOp?: { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number }; readonly sourceEventSeqs?: readonly number[] },
  ): { readonly seq: number }
}

/**
 * Rewrite every over-budget tool result on a session's surface as a durable replacement.
 *
 * A class rather than a function because the budget and the estimator are configuration
 * a plugin holds once, and because DSH's equivalent is a service with exactly these two
 * injected facts.
 */
export class ToolResultPruner {
  /** Held as fields rather than constructor parameter properties, because this project compiles with `erasableSyntaxOnly`. */
  private readonly config: PruneConfig
  private readonly estimate: (message: Message) => number

  /**
   * Resolve the budget and refuse one that cannot work.
   *
   * The invariant is DSH's, and its reason is the second-pass case: a replacement is
   * head + marker + tail, so if that sum exceeded the trigger the replacement would
   * still be over the threshold and the next pass would prune it forever without ever
   * getting under. The error names each number so a bad configuration is diagnosable
   * from the message alone.
   */
  constructor(config: Partial<PruneConfig> = {}, estimate: (message: Message) => number = estimateMessage) {
    this.config = resolvePruneConfig(config)
    const emitted = this.config.headChars + PRUNE_MARKER.length + this.config.tailChars
    if (emitted > this.config.thresholdChars) {
      throw new Error(
        `ToolResultPruner: headChars (${this.config.headChars}) + marker (${PRUNE_MARKER.length}) + tailChars (${this.config.tailChars}) = ${emitted} must be at most thresholdChars (${this.config.thresholdChars})`,
      )
    }
    this.estimate = estimate
  }

  /**
   * Rewrite every over-budget tool result as a surface replacement.
   *
   * The pass, and its order, is DSH's: one snapshot of the surface, walked in surface
   * order; a node whose message is not a `tool` message is skipped; the node's own text
   * is measured against the per-result threshold; an over-budget node becomes a
   * `compaction/prune` shadow price followed by a replacement message that differs from
   * the original only in `content` and cites it through `surfaceOp` and
   * `sourceEventSeqs`. A node whose parts are each under the threshold even though their
   * sum is over it is left alone, because nothing would actually change.
   */
  pruneSession(store: PrunableStore, handle: SessionHandle): { readonly pruned: number; readonly charsRemoved: number } {
    let pruned = 0
    let charsRemoved = 0
    // Snapshot first: appending during the walk must not extend the walk, or a
    // replacement could be reconsidered within the same pass.
    for (const seq of [...store.surface(handle).nodes]) {
      const original = store.deriveNode(handle, seq)
      if (original === null || original.role !== 'tool') continue
      const before = measureText(original.content)
      if (before <= this.config.thresholdChars) continue

      const content: ContentPart[] = []
      let changed = false
      let removed = 0
      // Non-text parts are copied across where they are, never reordered or dropped.
      for (const part of original.content) {
        if (part.type !== 'text') {
          content.push(part)
          continue
        }
        const result = pruneText(part.text, this.config)
        if (result.pruned) {
          changed = true
          removed += part.text.length - result.text.length
        }
        content.push({ type: 'text', text: result.text })
      }
      if (!changed) continue

      // Before the replacement, never after: a consumer reading forward can subtract
      // the shadowed cost before it reaches what replaced it.
      store.append(handle, {
        type: 'compaction/prune',
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.estimate(original),
      })
      store.append(
        handle,
        { type: 'message', message: { ...original, content } },
        { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] },
      )
      pruned += 1
      charsRemoved += removed
    }
    return { pruned, charsRemoved }
  }
}
