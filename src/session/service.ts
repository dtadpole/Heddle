import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { canonicalPath } from '../paths.ts'
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

  /**
   * The folder's current session: the newest session whose working directory is exactly this folder.
   *
   * This is the whole of "one folder, one session". A folder's session is not a stored pointer but a
   * question with an answer — the newest log bound to that folder — so a session created by another
   * process, or by an older build, is the folder's session the moment it is the newest one there.
   * Sessions that are no longer current are still in the store, still listed, still readable by id;
   * they simply are not what the folder points at.
   */
  current(folder: string): SessionMeta | null {
    const canonical = canonicalPath(folder)
    return this.list().find((meta) => canonicalPath(meta.cwd) === canonical) ?? null
  }

  /**
   * Open the session **bound to a folder**, creating one when the folder has none.
   *
   * `fresh` starts a new session regardless of what the folder holds, which then becomes the
   * folder's current session — the `--new` path. The old one is untouched: nothing is rewritten, and
   * the folder simply points somewhere else afterwards.
   */
  openAt(
    folder: string,
    options: { readonly fresh?: boolean; readonly endpoint?: string; readonly model?: string; readonly title?: string } = {},
  ): SessionHandle {
    const canonical = canonicalPath(folder)
    if (options.fresh !== true) {
      const existing = this.current(canonical)
      if (existing !== null) {
        const handle = this.store.open(existing.id)
        if (handle !== null) return handle
      }
    }
    return this.store.create({
      cwd: canonical,
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.title !== undefined ? { title: options.title } : {}),
    })
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
