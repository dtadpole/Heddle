import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { ContextAssembler, estimateMessages, type AssembleOptions, type ContextReport } from './assembler.ts'
import type { Message } from '../llm/types.ts'
import type { SessionHandle, SessionStore } from '../session/store.ts'

export * from './assembler.ts'

export const name = 'context'

export const Config = Schema.object({
  /** The system prompt every turn begins with. */
  system: Schema.string(),
  /** The context window to budget against, in tokens. */
  contextWindow: Schema.number().default(1_048_576),
  /** Compact when the estimate reaches this many tokens; defaults to 80 percent. */
  thresholdTokens: Schema.number(),
  /** Read AGENTS.md and CLAUDE.md from the workspace. */
  instructions: Schema.boolean().default(true),
  /** The endpoint a compaction summary is asked of; defaults to the turn's. */
  endpoint: Schema.string(),
  /** The model a compaction summary is asked of; defaults to the endpoint's. */
  model: Schema.string(),
})

export interface Config {
  readonly system?: string
  readonly contextWindow?: number
  readonly thresholdTokens?: number
  readonly instructions?: boolean
  readonly endpoint?: string
  readonly model?: string
}

/**
 * The context service.
 *
 * It owns the assembler and the compaction step, and it is the only thing the loop
 * asks about context. Splitting the assembler out as a plain class is deliberate: the
 * assembly rules are a pure function of a session log, so they can be reasoned about
 * and tested without a context, and only the compaction needs to make a model call.
 */
export class ContextService extends Service {
  static readonly provide = 'context'

  readonly assembler: ContextAssembler
  private readonly store: SessionStore
  private readonly config: Required<Pick<Config, 'contextWindow' | 'instructions'>> & Config

  constructor(ctx: Context, store: SessionStore, config: Config = {}) {
    super(ctx, 'context')
    this.store = store
    this.config = {
      ...config,
      contextWindow: config.contextWindow ?? 1_048_576,
      instructions: config.instructions ?? true,
    }
    this.assembler = new ContextAssembler(store)
  }

  /** Assemble the messages for one request, applying the budget. */
  assemble(options: { readonly session: SessionHandle; readonly cwd: string; readonly tools?: readonly import('../llm/types.ts').ToolSpec[] }): ContextReport {
    const assembleOptions: AssembleOptions = {
      session: options.session,
      cwd: options.cwd,
      contextWindow: this.config.contextWindow,
      instructions: this.config.instructions,
      ...(this.config.system !== undefined ? { system: this.config.system } : {}),
      ...(this.config.thresholdTokens !== undefined ? { thresholdTokens: this.config.thresholdTokens } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
    }
    return this.assembler.assemble(assembleOptions)
  }

  /**
   * Compact the session if the assembled context is over its threshold.
   *
   * The summary is produced by a model call that **replays the span being shadowed**,
   * as DSH's compaction engine does, so a provider's prefix cache still applies. The
   * events written are the four DSH writes: start, summary, a replacement summary
   * message, and end — and the shadowed messages stay in the log, so `heddle
   * transcript` still shows everything.
   */
  async compactIfNeeded(options: {
    readonly session: SessionHandle
    readonly endpoint: string
    readonly model?: string
    /** Replace the model call, so a check can compact without spending anything. */
    readonly summarize?: (messages: readonly Message[]) => Promise<string>
  }): Promise<{ readonly compacted: boolean; readonly estimatedTokens: number; readonly reason?: string }> {
    const plan = this.assembler.plan({
      session: options.session,
      contextWindow: this.config.contextWindow,
      ...(this.config.thresholdTokens !== undefined ? { thresholdTokens: this.config.thresholdTokens } : {}),
    })
    if (!plan.needed || plan.fromSeq === undefined || plan.throughSeq === undefined) {
      return { compacted: false, estimatedTokens: plan.estimatedTokens }
    }

    const events = this.store.read(options.session)
    const span = events.filter((event) => event.seq >= (plan.fromSeq ?? 0) && event.seq <= (plan.throughSeq ?? 0))
    const spanMessages = span
      .filter((event) => event.type === 'message' || event.type === 'assistant/chunk')
      .map((event) => (event.type === 'message' ? (event.message as Message) : undefined))
      .filter((message): message is Message => message !== undefined)

    this.store.append(options.session, {
      type: 'compaction/start',
      fromSeq: plan.fromSeq,
      throughSeq: plan.throughSeq,
      estimatedTokens: plan.estimatedTokens,
      thresholdTokens: this.config.thresholdTokens ?? Math.floor(this.config.contextWindow * 0.8),
    })

    let summary: string
    const summarize = options.summarize ?? this.modelSummarizer(options)
    try {
      summary = await summarize(spanMessages)
    } catch (error) {
      this.store.append(options.session, {
        type: 'compaction/failed',
        fromSeq: plan.fromSeq,
        throughSeq: plan.throughSeq,
        reason: (error as Error).message,
      })
      return { compacted: false, estimatedTokens: plan.estimatedTokens, reason: (error as Error).message }
    }

    if (summary.trim().length === 0) {
      this.store.append(options.session, {
        type: 'compaction/failed',
        fromSeq: plan.fromSeq,
        throughSeq: plan.throughSeq,
        reason: 'the summariser returned nothing',
      })
      return { compacted: false, estimatedTokens: plan.estimatedTokens, reason: 'the summariser returned nothing' }
    }

    const framed = `<compacted-summary>\n${summary.trim()}\n</compacted-summary>`
    this.store.append(options.session, {
      type: 'compaction/summary',
      fromSeq: plan.fromSeq,
      throughSeq: plan.throughSeq,
      summary: framed,
      shadowed: span.length,
    })
    // A message event as well, so the record reads as a conversation with a checkpoint
    // in it rather than as a log with an annotation on the side.
    this.store.message(options.session, {
      role: 'user',
      content: [{ type: 'text', text: framed }],
    })
    this.store.append(options.session, {
      type: 'compaction/end',
      fromSeq: plan.fromSeq,
      throughSeq: plan.throughSeq,
      summaryTokens: Math.ceil(framed.length / 4),
    })

    const after = this.store
      .read(options.session)
      .filter((event) => event.type === 'message' && event.seq > (plan.throughSeq ?? 0))
      .map((event) => event.message as Message)
      .filter((message): message is Message => message !== undefined)
    this.store.append(options.session, {
      type: 'compaction/measured',
      before: plan.estimatedTokens,
      after: estimateMessages(after),
    })

    return { compacted: true, estimatedTokens: estimateMessages(after) }
  }

  /** The default summariser: one model call, replaying the span and asking for a briefing. */
  private modelSummarizer(options: { readonly endpoint: string; readonly model?: string }): (messages: readonly Message[]) => Promise<string> {
    return async (messages) => {
      const endpoint = this.config.endpoint ?? options.endpoint
      const model = this.config.model ?? options.model
      const result = await this.ctx.model.generate({
        endpoint,
        ...(model !== undefined ? { model } : {}),
        messages: [
          ...messages,
          { role: 'user', content: [{ type: 'text', text: COMPACTION_PROMPT }] },
        ],
        maxOutputTokens: 1024,
      })
      return result.text
    }
  }
}

/** The compaction instruction, imported from the assembler so there is one copy. */
const COMPACTION_PROMPT = `Summarise the conversation above so it can continue without the original messages. Keep every decision, constraint, file path, command and result that still matters. Keep unresolved questions and what was tried. Drop greetings and repetition. Write it as a briefing to yourself, not as a reply to the user.`

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['context']`. */
    context: ContextService
  }
}

/** The context plugin. */
export default class ContextPlugin extends ContextService {
  static readonly Config = Config

  static readonly inject = ['model', 'session']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, ctx.session.store, config)
  }

  /** Assemble for the current session, which is what the loop asks for. */
  assembleFor(session: SessionHandle, cwd: string, tools?: readonly import('../llm/types.ts').ToolSpec[]): ContextReport {
    return this.assemble({ session, cwd, ...(tools !== undefined ? { tools } : {}) })
  }
}
