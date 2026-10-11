import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { defaultSessionRoot, SessionStore } from '../session/store.ts'
import { SessionService } from '../session/service.ts'

export const name = 'session'

/** The session plugin: the service class plus its own config schema. */
export default class SessionPlugin extends SessionService {
  static readonly Config = Schema.object({
    /** Where sessions live. Defaults to `$HEDDLE_HOME/sessions`. */
    root: Schema.string().default(defaultSessionRoot()),
  })

  constructor(ctx: Context, config: { root?: string } = {}) {
    /**
     * Every append is re-emitted on the context.
     *
     * This is the seam the Web UI listens on, and it is a Cordis event rather than a
     * callback the server registers, so a consumer is owned by its own fiber and is
     * released with it. DSH carries the equivalent as `session/event`.
     */
    super(ctx, config, {
      onEvent: (handle, event) => {
        ctx.emit('session/event', { session: handle.id, event })
      },
    })
  }
}

export { SessionStore }
