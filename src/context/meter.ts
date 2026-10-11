import type { ContentPart, Message, ToolSpec } from '../llm/types.ts'

/**
 * Token metering: what a request costs, and which number to believe.
 *
 * A faithful port of DSH's `@deepseek-ai/dsh-token-meter` estimate, kept out of
 * the assembler because a meter that also assembles cannot be checked against a
 * hand-counted request. The parts worth naming:
 *
 * - **The estimate is deterministic and deliberately low.** Four characters per
 *   token plus fixed per-block and per-role overhead, the same constants DSH
 *   uses. Being deterministic is what lets it be a budget trigger, and being a
 *   lower bound is what makes a provider number below it meaningless rather
 *   than merely surprising.
 * - **Provider usage is a cross-check, never a correction downwards.** DSH
 *   reuses the last call's usage only when the request envelope is unchanged and
 *   the total is no lower than that envelope's estimate; this keeps that rule.
 * - **Route pricing and the heuristic are two fields, not two calls.** DSH
 *   prices images per routed model and therefore reports `tokens` separately
 *   from `heuristicTokens`. There is no route-priced block in this harness yet,
 *   so the two agree today; the shape is kept so an adapter can start pricing
 *   without a caller changing.
 */

/** Four characters per token, the density DSH's fixed estimate assumes when it has no count. */
export const CHARS_PER_TOKEN = 4
/** Fixed cost of one content block: JSON framing and the type tag. */
export const BLOCK_OVERHEAD = 4
/** Fixed cost of one message's role framing. */
export const ROLE_OVERHEAD = 4

/**
 * Price one content part.
 *
 * A tool call is priced with **two** ceilings, one over the name and one over
 * the arguments, rather than one over the concatenation. That is DSH's
 * arithmetic, verified against its source, and it is not a rounding
 * coincidence: the two halves are separately framed on the wire, so pricing
 * them joined undercounts by up to a token and would drift below the real
 * envelope over a long tool-heavy session.
 */
export function estimatePart(part: ContentPart): number {
  if (part.type === 'text' || part.type === 'reasoning') {
    return Math.ceil(part.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }
  if (part.type === 'tool-call') {
    return Math.ceil(part.name.length / CHARS_PER_TOKEN) + Math.ceil(part.arguments.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
  }
  // The union is merge-extensible, so a block this file does not know about is
  // still priced rather than ignored: its JSON structure is the honest floor.
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(part).length / CHARS_PER_TOKEN)
}

/** Price the content of one message, block by block, including per-block overhead. */
export function estimateContent(parts: readonly ContentPart[]): number {
  let tokens = 0
  for (const part of parts) tokens += estimatePart(part)
  return tokens
}

/**
 * Price one model-visible message.
 *
 * A system message is the exception, and it is the one DSH carves out too: an
 * adapter renders the prompt as a single string — a system-role message or the
 * request's system field — so there is no per-block framing to pay for, and an
 * empty content array means "no system prompt" and prices as zero rather than
 * as one empty role.
 */
export function estimateMessage(message: Message): number {
  if (message.role === 'system') {
    if (message.content.length === 0) return 0
    let characters = 0
    for (const part of message.content) {
      characters += part.type === 'text' ? part.text.length : JSON.stringify(part).length
    }
    return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
  }
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the tool schemas a request carries.
 *
 * One JSON serialisation plus one block of framing, because the schemas travel
 * as one field of the envelope. Absent and empty are the same thing here: both
 * mean the request offers no tools.
 */
export function estimateTools(tools: readonly ToolSpec[] | undefined): number {
  if (tools === undefined || tools.length === 0) return 0
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/** One priced surface node: its session position and what it costs. */
export interface MeterNode {
  /** The session event this node derives from, so a caller can point at it. */
  readonly seq: number
  /** The price actually used, which is route-priced where a route prices. */
  readonly tokens: number
  /** The fixed-heuristic price, kept even when `tokens` disagrees with it. */
  readonly heuristicTokens: number
}

/** One coherent snapshot of a surface's cost, and the baseline that total rests on. */
export interface Measurement {
  /** The number to budget against: the adopted baseline, never below the estimate. */
  readonly totalTokens: number
  /** Where `totalTokens` came from, so a caller can say how much it trusts it. */
  readonly baseline: { readonly kind: 'usage' | 'estimated' | 'none'; readonly tokens: number }
  /** The surface in order, each node priced. */
  readonly nodes: readonly MeterNode[]
  /** The part of the estimate that is system prompts. */
  readonly systemTokens: number
  /** The part of the estimate that is the tool schemas. */
  readonly toolsTokens: number
  /** The part of the estimate that is every other message. */
  readonly messageTokens: number
}

/** What to measure: the surface, its tools, and any usage for the same envelope. */
export interface MeterInput {
  /** The surface, in order: each node's seq and the message it derives to. */
  readonly nodes: readonly { readonly seq: number; readonly message: Message }[]
  readonly tools?: readonly ToolSpec[]
  /** Provider usage for the last call, with the surface generation it was measured at. */
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly generation: number }
  /** The surface's current content generation. */
  readonly generation: number
}

/**
 * The meter.
 *
 * A plain class rather than a Cordis service, unlike DSH's, because `measure`
 * is a pure function of its input: there is no replay state to own and nothing
 * to release on disposal. It stays a class so the call site reads like DSH's
 * and a stateful metering strategy can replace it without a rewrite.
 */
export class TokenMeter {
  /** Measure one surface, choosing the baseline the total rests on. */
  measure(input: MeterInput): Measurement {
    const nodes: MeterNode[] = []
    let systemTokens = 0
    let messageTokens = 0
    for (const node of input.nodes) {
      const heuristicTokens = estimateMessage(node.message)
      // Route pricing does not exist here yet, so the used price is the estimate;
      // the fields stay apart because DSH reports them apart and a future adapter
      // must be able to price a node without this interface moving.
      nodes.push({ seq: node.seq, tokens: heuristicTokens, heuristicTokens })
      if (node.message.role === 'system') systemTokens += heuristicTokens
      else messageTokens += heuristicTokens
    }
    const toolsTokens = estimateTools(input.tools)
    const estimatedTotal = systemTokens + messageTokens + toolsTokens

    const usage = input.usage
    // Usage is reused only for the same envelope: the generation must match, so
    // nothing has been added or replaced since the call it reports on. And it must
    // be no lower than the estimate — a provider total below a deterministic lower
    // bound is either a different envelope or a bad report, and adopting it would
    // hide pressure exactly when the surface is over budget.
    if (usage !== undefined && usage.generation === input.generation) {
      const usageTotal = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
      if (usageTotal >= estimatedTotal) {
        return {
          totalTokens: usageTotal,
          baseline: { kind: 'usage', tokens: usageTotal },
          nodes,
          systemTokens,
          toolsTokens,
          messageTokens,
        }
      }
    }

    // Nothing to price and no usable usage is the one case with no number at all,
    // which is what lets a caller distinguish "empty request" from "cheap request".
    if (input.nodes.length === 0 && (input.tools === undefined || input.tools.length === 0)) {
      return {
        totalTokens: 0,
        baseline: { kind: 'none', tokens: 0 },
        nodes,
        systemTokens,
        toolsTokens,
        messageTokens,
      }
    }

    return {
      totalTokens: estimatedTotal,
      baseline: { kind: 'estimated', tokens: estimatedTotal },
      nodes,
      systemTokens,
      toolsTokens,
      messageTokens,
    }
  }
}
