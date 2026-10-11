import { Logger } from '@deepseek-ai/cordis'
import type { Context, Exporter } from '@deepseek-ai/cordis'

/** Name this plugin is registered and logged under. */
export const name = 'console-exporter'

/**
 * Send the built-in logger's records to the terminal.
 *
 * Cordis's logger collects records in a buffer and hands them to whatever
 * exporters are registered, so a fresh context is silent until one is. The
 * exporter is registered with `ctx.logger.exporter()`, which is an effect: it is
 * removed when this fiber unloads.
 *
 * @param ctx - the context to attach the exporter to.
 */
export function apply(ctx: Context): void {
  const exporter: Exporter = {
    colors: process.stdout.isTTY ? 3 : false,
    export(message) {
      const line = Logger.format(exporter, message)
      const stream = message.level === 0 ? process.stderr : process.stdout
      stream.write(`${line}\n`)
    },
  }
  ctx.logger.exporter(exporter)
}
