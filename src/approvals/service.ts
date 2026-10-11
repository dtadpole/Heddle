import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'approvals'

/** What the policy says about one call. */
export interface ApprovalDecision {
  readonly allowed: boolean
  readonly mode: ApprovalMode
  /** Present when refused; this is the sentence a user is shown. */
  readonly reason?: string
}

export type ApprovalMode = 'allow' | 'deny' | 'ask'

export const Config = Schema.object({
  /**
   * The standing policy.
   *
   * `ask` is the honest default for an unattended harness and the awkward one for
   * a headless run: with no one to answer, an `ask` is a denial with a reason. The
   * loop reports it as such rather than hanging or silently allowing.
   */
  mode: Schema.union([Schema.const('allow' as const), Schema.const('deny' as const), Schema.const('ask' as const)]).default(
    'allow',
  ),
  /** Tools refused by name, whatever the mode says. */
  deny: Schema.array(Schema.string()).default([]),
  /** Tools allowed by name even when the mode is `deny`. */
  allow: Schema.array(Schema.string()).default([]),
  /** Answer given to an `ask` when nothing can answer it. */
  unanswered: Schema.union([Schema.const('deny' as const), Schema.const('allow' as const)]).default('deny'),
})

export interface Config {
  readonly mode?: ApprovalMode
  readonly deny?: readonly string[]
  readonly allow?: readonly string[]
  readonly unanswered?: 'deny' | 'allow'
}

/**
 * The approval policy.
 *
 * The point of the service existing separately from the sandbox is that the two
 * refuse different things and a user needs to know which one stopped them: the
 * sandbox refuses **where** an effect lands, the policy refuses **whether** an
 * action may be taken at all. A tool denied by name is a different sentence from a
 * path outside the workspace, and collapsing the two loses the diagnosis.
 *
 * This is also where DSH's approval concept lives — a decision that a person may
 * be asked for. `ask` is modelled rather than implemented as a prompt, because a
 * prompt is a UI concern; a run with no one to answer gets its `unanswered`
 * answer, and says so.
 */
export class ApprovalService extends Service {
  static readonly provide = 'approvals'

  readonly mode: ApprovalMode
  readonly deny: readonly string[]
  readonly allow: readonly string[]
  readonly unanswered: 'deny' | 'allow'

  /** Every decision this process made, so a run can report what it refused. */
  private readonly decisions: { tool: string; allowed: boolean; reason?: string }[] = []

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'approvals')
    this.mode = config.mode ?? 'allow'
    this.deny = config.deny ?? []
    this.allow = config.allow ?? []
    this.unanswered = config.unanswered ?? 'deny'
  }

  /** Decide one call, and remember the decision. */
  check(tool: string): ApprovalDecision {
    const decision = this.decide(tool)
    this.decisions.push({ tool, allowed: decision.allowed, ...(decision.reason !== undefined ? { reason: decision.reason } : {}) })
    return decision
  }

  private decide(tool: string): ApprovalDecision {
    if (this.deny.includes(tool) && !this.allow.includes(tool)) {
      return { allowed: false, mode: this.mode, reason: `the approval policy denies '${tool}' by name` }
    }
    if (this.mode === 'allow') return { allowed: true, mode: this.mode }
    if (this.mode === 'deny') {
      if (this.allow.includes(tool)) return { allowed: true, mode: this.mode, reason: `'${tool}' is allowed by name` }
      return { allowed: false, mode: this.mode, reason: `the approval policy is 'deny' and '${tool}' is not allowed by name` }
    }
    // `ask` with no one to answer.
    if (this.unanswered === 'allow') return { allowed: true, mode: this.mode, reason: `'${tool}' was not asked; unanswered defaults to allow` }
    return {
      allowed: false,
      mode: this.mode,
      reason: `the approval policy asks before '${tool}', and this run has no one to answer, so it is refused`,
    }
  }

  /** The decisions made in this process, in order. */
  history(): readonly { tool: string; allowed: boolean; reason?: string }[] {
    return this.decisions
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['approvals']`. */
    approvals: ApprovalService
  }
}

/**
 * The plugin is the service class itself, so the Cordis loader's own `inject`
 * row gates it — the mechanism DSH uses, rather than an exported `inject` array
 * that a hand-written `ctx.set` path ignores. Measured: the function form threw
 * "cannot get property ... without inject" while the loader reported nothing,
 * because `ctx.set` does not go through the inject gate.
 */
export default class ApprovalServicePlugin extends ApprovalService {
  /** Declared on the plugin so the loader validates and applies the row's config. */
  static readonly Config = Config
}

