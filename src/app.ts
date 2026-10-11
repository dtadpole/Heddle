import { Context } from '@deepseek-ai/cordis'
import * as consoleExporter from './plugins/console-exporter.ts'
import * as announce from './plugins/announce.ts'
import Greeting from './plugins/greeting.ts'

/** What a caller may configure when building an application. */
export interface HeddleOptions {
  /** Punctuation the greeting service appends. Defaults to `!`. */
  readonly punctuation?: string
  /** Who a run is for; announced on `heddle/ready`. Defaults to `heddle`. */
  readonly target?: string
  /** Skip the console exporter, which is what tests want. */
  readonly quiet?: boolean
}

/** A loaded application: a context plus the one way to tear it down. */
export interface HeddleApp {
  /** The root context every plugin hangs off. */
  readonly ctx: Context
  /** The resolved target, so a caller does not have to repeat the default. */
  readonly target: string
  /** Unload every plugin and release the context. */
  dispose(): Promise<void>
}

/**
 * Build the root context and load Heddle's plugins into it.
 *
 * `await ctx.plugin(...)` settles once loading finished and rejects on a config or
 * startup error, so a broken plugin fails here rather than at first use. Plugin
 * order is not load order: a plugin that injects a service simply stays `pending`
 * until that service exists.
 *
 * @param options - see {@link HeddleOptions}.
 * @returns the loaded application.
 */
export async function createApp(options: HeddleOptions = {}): Promise<HeddleApp> {
  const ctx = new Context()
  const target = options.target ?? 'heddle'

  if (!options.quiet) {
    await ctx.plugin(consoleExporter)
  }
  await ctx.plugin(Greeting, { punctuation: options.punctuation })
  await ctx.plugin(announce, { target })

  return {
    ctx,
    target,
    dispose: () => ctx.fiber.dispose(),
  }
}
