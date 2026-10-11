import type { Context } from '@deepseek-ai/cordis'
import '../events.ts'

/** Name this plugin is registered and logged under. */
export const name = 'announce'

/**
 * Load only once `greeting` exists.
 *
 * This is the Cordis gate rather than an ordering guarantee: until the service is
 * provided the fiber stays `pending` and {@link apply} has not run. If the service
 * is later replaced or removed, the fiber unloads and this runs again.
 */
export const inject = ['greeting']

/** Config accepted from the loader or from `ctx.plugin()`. */
export interface Config {
  readonly target?: string
}

/**
 * Announce a ready application through the greeting service.
 *
 * @param ctx - the plugin's own context, which owns every effect registered here.
 * @param config - the validated config, if any.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.on('heveld/ready', (target) => {
    ctx.logger.info('announce %s', ctx.greeting.greet(config.target ?? target))
  })
}
