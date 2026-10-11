import type { Context } from '@deepseek-ai/cordis'

import type { Chunk, Message, ToolSpec } from '../llm/types.ts'
import type { SessionHandle } from '../session/store.ts'
import type { ToolResult } from '../tools/service.ts'

/**
 * The agent loop.
 *
 * One turn is: record the user's message, ask the model, run whatever tools it
 * asked for, feed the results back, and stop when it answers without asking for
 * another tool. Every step is on disk **before** the next one starts, so a killed
 * run reads as a partial turn rather than as nothing.
 *
 * The loop is deliberately small and lives outside the plugins that supply its
 * parts. It has no knowledge of which endpoint answers, which tools exist, or what
 * the sandbox permits; it asks for all three through services. That is what makes
 * the parts independently verifiable — each one's own verifier judges it without
 * the loop, and the end-to-end verifier judges the loop with all of them.
 */

/** What happened in one turn, including what was refused. */
export interface TurnResult {
  /** The answer's text, which is what a caller prints. */
  readonly text: string
  readonly reasoning: string
  readonly toolCalls: readonly { name: string; arguments: string; result: ToolResult }[]
  /** Refusals, kept separate because a refused call is the sandbox's evidence. */
  readonly denials: readonly { tool: string; code: string; message: string }[]
  readonly finishReason: string
  /** How many events the turn added, so a caller can point at the transcript. */
  readonly events: number
  /** Rounds of model-plus-tools this turn took. */
  readonly rounds: number
}

export interface RunTurnOptions {
  /** The session this turn is recorded in. */
  readonly session: SessionHandle
  /** Which configured endpoint answers. */
  readonly endpoint: string
  /** The user's message for this turn. */
  readonly prompt: string
  /** A system prompt, recorded as the first message of a new session. */
  readonly system?: string
  /** The model id, overriding the endpoint's default. */
  readonly model?: string
  /** Cap on model-plus-tools rounds, so a looping model cannot run forever. */
  readonly maxRounds?: number
  /** Cap on generated tokens per model call. */
  readonly maxOutputTokens?: number
  readonly signal?: AbortSignal
}

/** The services a turn needs, narrowed to what it uses. */
interface TurnDeps {
  readonly ctx: Context
  readonly model: {
    names(): readonly string[]
    stream(request: Parameters<Context['model']['stream']>[0], signal?: AbortSignal): AsyncIterable<Chunk>
  }
  readonly session: Context['session']
  readonly tools: Context['tools']
}

/** Turn the tool registry's descriptions into what the model is told. */
function specsOf(tools: Context['tools']): readonly ToolSpec[] {
  return tools.describe().map((spec) => spec)
}

/**
 * Run one turn.
 *
 * `maxRounds` defaults to eight: enough for a task that reads, writes and checks,
 * and small enough that a model which keeps asking for tools is stopped with a
 * readable transcript rather than an open-ended bill.
 */
export async function runTurn(ctx: Context, options: RunTurnOptions): Promise<TurnResult> {
  const started = ctx.session.store.count(options.session)
  const maxRounds = options.maxRounds ?? 8
  const maximumTokens = options.maxOutputTokens

  if (options.system !== undefined && ctx.session.messages(options.session).length === 0) {
    ctx.session.store.message(options.session, { role: 'system', content: [{ type: 'text', text: options.system }] })
  }
  ctx.session.user(options.session, options.prompt)

  const tools = specsOf(ctx.tools)
  const denials: { tool: string; code: string; message: string }[] = []
  const toolCallRecords: { name: string; arguments: string; result: ToolResult }[] = []
  let text = ''
  let reasoning = ''
  let finishReason = 'unknown'
  let rounds = 0
  const ended: string[] = []

  for (let round = 0; round < maxRounds; round += 1) {
    rounds += 1
    const messages = ctx.session.messages(options.session)
    ctx.session.store.modelRequest(options.session, {
      endpoint: options.endpoint,
      ...(options.model !== undefined ? { model: options.model } : {}),
      messages: messages.length,
      tools: tools.map((tool) => tool.name),
    })

    const request = {
      endpoint: options.endpoint,
      messages: messages as readonly Message[],
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(maximumTokens !== undefined ? { maxOutputTokens: maximumTokens } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      sessionId: options.session.id,
    }

    const calls: { id: string; name: string; arguments: string }[] = []
    let roundText = ''
    for await (const chunk of ctx.model.stream(request, options.signal)) {
      // Recorded as it arrives: the transcript of an interrupted turn should show
      // the half of the answer that arrived.
      ctx.session.store.assistantChunk(options.session, chunk)
      if (chunk.type === 'text-delta') roundText += chunk.text
      else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      else if (chunk.type === 'tool-call') calls.push({ id: chunk.id, name: chunk.name, arguments: chunk.arguments })
      else if (chunk.type === 'done') {
        finishReason = chunk.finishReason
        ended.push(`round ${round + 1}: ${chunk.finishReason}`)
      }
    }
    text += roundText

    if (calls.length === 0) break

    for (const call of calls) {
      const args = parseArguments(call.arguments)
      const result = await ctx.tools.call(call.name, args, {
        cwd: ctx.sandbox.workspaceRoot,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        log: (message) => ctx.logger.info('turn: %s', message),
      })
      toolCallRecords.push({ name: call.name, arguments: call.arguments, result })
      if (result.error) {
        denials.push({ tool: call.name, code: result.error.code, message: result.error.message })
      }
      ctx.session.store.message(options.session, {
        role: 'tool',
        toolCallId: call.id,
        content: [
          {
            type: 'text',
            text: result.error
              ? `error (${result.error.code}): ${result.error.message}`
              : result.output.length > 0
                ? result.output
                : '(the tool produced no output)',
          },
        ],
      })
    }
  }

  if (rounds >= maxRounds) {
    ended.push(`stopped after the round limit of ${maxRounds}`)
  }
  ctx.session.store.append(options.session, {
    type: 'assistant/completed',
    text,
    reasoning,
    finishReason,
    rounds,
    denials: denials.length,
  })
  ctx.session.store.append(options.session, { type: 'turn/completed', rounds })

  return {
    text,
    reasoning,
    toolCalls: toolCallRecords,
    denials,
    finishReason,
    events: ctx.session.store.count(options.session) - started,
    rounds,
  }
}

/**
 * Parse a tool call's arguments.
 *
 * A malformed argument string is not a crash: the model's own syntax error is
 * handed back to the tool as an empty object with the raw text kept, so the
 * registry refuses it as bad arguments and the model gets told what it wrote.
 * Measured on a real model, which does occasionally emit a truncated JSON.
 */
function parseArguments(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {}
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : { value }
  } catch {
    return { __unparsed: raw }
  }
}
