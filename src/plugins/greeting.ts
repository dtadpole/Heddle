import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Name this plugin is registered and logged under. */
export const name = 'greeting'

const schema = Schema.object({
  punctuation: Schema.string().default('!'),
})

/**
 * The plugin's config schema.
 *
 * Cordis validates config against this before the plugin body runs, so a bad
 * value fails the load with a `ValidationError` instead of surfacing later as an
 * undefined field. Schemastery fills `default()` values during that validation.
 */
export const Config = schema

/** The validated shape of {@link Config}. */
export interface Config {
  readonly punctuation: string
}

/**
 * The first Heveld service.
 *
 * A service is an object registered on the context under a name, owned by the
 * fiber of the plugin that created it: when that fiber unloads the service
 * disappears, and every plugin that injected it is refreshed. Extending `Service`
 * is the shorthand for "provide myself under this name".
 */
export class Greeting extends Service {
  /** Lets the loader and `super()` find the schema and the service name. */
  static readonly Config = schema
  static readonly provide = 'greeting'

  /**
   * A TypeScript `private` field, deliberately not a `#private` one: Cordis hands
   * services out through a tracing proxy, so a method runs with `this` bound to a
   * proxy rather than the instance, and a `#field` brand check would throw.
   */
  private readonly punctuation: string

  /** Config arrives validated, so `punctuation` is always a string here. */
  constructor(ctx: Context, config: Partial<Config> = {}) {
    super(ctx, Greeting.provide)
    this.punctuation = config.punctuation ?? '!'
  }

  /** Build the greeting this service exists to produce. */
  greet(who = 'world'): string {
    return `hello, ${who}${this.punctuation}`
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by {@link Greeting}; reads require `inject: ['greeting']`. */
    greeting: Greeting
  }
}

export default Greeting
