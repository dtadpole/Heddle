import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import type { Message } from '../llm/types.ts'

import { SessionStore, defaultSessionRoot, type RecordedMessage, type SessionHandle, type SessionId, type SessionMeta, type SurfaceState } from './store.ts'

export * from './store.ts'

export const name = 'session'

export const Config = Schema.object({
  /** Where sessions live. Defaults to `$HEDDLE_HOME/sessions`. */
  root: Schema.string().default(defaultSessionRoot()),
})

export interface Config {
  readonly root?: string
}

/**
 * The session service.
 *
 * A thin Cordis face over the store, so a consumer writes `ctx.session.turn(...)`
 * and never touches a path. The store itself stays a plain class with no Cordis
 * dependency, which is what lets it be tested without a context.
 */
export class SessionService extends Service {
  static readonly provide = 'session'

  readonly store: SessionStore

  constructor(
    ctx: Context,
    config: Config = {},
    options: { readonly onEvent?: (handle: SessionHandle, event: import('./store.ts').SessionEvent) => void } = {},
  ) {
    super(ctx, 'session')
    this.store = new SessionStore(config.root ?? defaultSessionRoot(), options)
  }

  /** Open the session a run continues, or start one. */
  start(options: { readonly resume?: SessionId; readonly cwd?: string; readonly endpoint?: string; readonly model?: string; readonly title?: string } = {}): SessionHandle {
    if (options.resume !== undefined) {
      const existing = this.store.open(options.resume)
      if (existing === null) throw new Error(`no session '${options.resume}' under ${this.store.root}`)
      return existing
    }
    return this.store.create({
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
    })
  }

  /** Record a user turn and return once it is on disk. */
  user(handle: SessionHandle, text: string): void {
    this.store.message(handle, { role: 'user', content: [{ type: 'text', text }] })
  }

  /** The messages a resumed session would send, which is what "carries" means. */
  messages(handle: SessionHandle): readonly RecordedMessage[] {
    return this.store.messages(handle)
  }

  /**
   * The surface: the positional view a request is derived from.
   *
   * Exposed because two things outside the store need it and neither may re-implement the fold:
   * compaction, which selects a span of positions to shadow, and a check, which judges that a
   * rewrite landed without erasing the log.
   */
  surface(handle: SessionHandle): SurfaceState {
    return this.store.surface(handle)
  }

  /** One node's derived message, or null when the node produces none. */
  node(handle: SessionHandle, seq: number): Message | null {
    return this.store.deriveNode(handle, seq)
  }

  /** What has already happened, for a caller that wants to show it. */
  events(handle: SessionHandle) {
    return this.store.read(handle)
  }

  /** Every session, newest first. */
  list(): readonly SessionMeta[] {
    return this.store.list()
  }

  /** The last complete answer, which is what a transcript read returns. */
  lastAnswer(handle: SessionHandle): string {
    return this.store.lastAnswer(handle)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['session']`. */
    session: SessionService
  }
}

/** The session plugin: one service, and the store under it. */
export default function session(ctx: Context, config: Config = {}): void {
  ctx.set('session', new SessionService(ctx, config))
}
