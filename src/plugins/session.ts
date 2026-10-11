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
    super(ctx, config)
  }
}

export { SessionStore }
