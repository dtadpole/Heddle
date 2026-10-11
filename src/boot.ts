import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { compose, readLayer, resolveSpecifier, type EntryRow, type Layer } from './config.ts'

/**
 * A boot: the composed row list, the running context, and how to stop it.
 *
 * `createApp` in `./app.ts` remains the way to build the framework's own
 * plugins in code, which is what the boot tests use. This is the way to build a
 * tree from data, which is what a harness needs: nothing in `src/plugins/` is
 * imported by the loader's path, so a tree can hold plugins this project has
 * never heard of.
 */
export interface Boot {
  /** The root context every entry hangs off. */
  readonly ctx: Context
  /** The rows this boot composed, in the order the layers produced them. */
  readonly rows: readonly EntryRow[]
  /** Entry ids in the loader's tree, in creation order. */
  readonly ids: readonly string[]
  /** The loader's entry ids, for a caller that wants to address one. */
  readonly loader: Loader
  /** Stop every entry and release the context. */
  dispose(): Promise<void>
}

/** Options for {@link boot}. */
export interface BootOptions {
  /** The base layer, normally the project's `cordis.yml`. */
  readonly base?: string
  /** Layers applied in order after the base; the last write wins per row. */
  readonly patches?: readonly string[]
  /** A configuration directory, used as the loader's `baseUrl`. */
  readonly configDir?: string
  /** Who the run is for, announced on `heddle/ready`; defaults to `heddle`. */
  readonly target?: string
}

/**
 * Boot a tree from configuration layers.
 *
 * Measured against the loader's own API while writing this: `create` resolves to
 * the entry's **id**, not to an entry, and a relative specifier is resolved
 * against the loader's `baseUrl` rather than against the importing file. Both
 * were wrong in the first draft, and both failed silently — an entry that never
 * started still appeared in `loader.entries()`.
 */
export async function boot(options: BootOptions = {}): Promise<Boot> {
  const configDir = resolve(options.configDir ?? process.cwd())
  /**
   * Relative specifiers resolve against the **configuration file's own
   * directory**, not the process's working directory.
   *
   * Measured while writing this: the first version used the working directory,
   * so a fixture at `.heddle-tmp/config-1/heddle.yml` declaring `./alpha.ts`
   * resolved to `<cwd>/alpha.ts`. The loader reported no error for the missing
   * module — it only logged one — so the run finished successfully with an empty
   * tree and the check read it as a configuration that loaded nothing.
   */
  const baseUrl =
    options.base !== undefined
      ? pathToFileURL(`${resolve(options.base, '..')}/`).href
      : pathToFileURL(`${configDir}/`).href

  const layers: Layer[][] = []
  if (options.base !== undefined) {
    layers.push([...readLayer(resolve(configDir, options.base))])
  }
  for (const patch of options.patches ?? []) {
    layers.push([...readLayer(resolve(configDir, patch))])
  }
  if (options.base !== undefined && options.patches === undefined) {
    const userLayer = resolve(configDir, 'heddle.patch.yml')
    if (existsSync(userLayer)) layers.push([...readLayer(userLayer)])
  }

  const rows = compose(layers)

  const ctx = new Context()
  await ctx.plugin(Loader, { baseUrl })

  const ids: string[] = []
  for (const row of rows) {
    const id = await ctx.loader.create({
      ...(row.id !== undefined ? { id: row.id } : {}),
      name: resolveSpecifier(row.name, baseUrl),
      ...(row.config !== undefined ? { config: row.config } : {}),
      ...(row.group !== undefined ? { group: row.group } : {}),
      ...(row.disabled !== undefined ? { disabled: row.disabled } : {}),
      ...(row.inject !== undefined ? { inject: row.inject } : {}),
    })
    ids.push(id)
  }
  await ctx.loader.await()
  /**
   * Announce the tree, exactly as `createApp` does.
   *
   * Without it a configured tree had no point at which a plugin could act once
   * everything it depends on exists: `inject` gates a plugin's body but says
   * nothing about when the tree is finished. Measured while writing the
   * configuration fixtures, whose consumers had nothing to listen for.
   */
  ctx.emit('heddle/ready', options.target ?? 'heddle')

  return {
    ctx,
    rows,
    ids,
    loader: ctx.loader,
    dispose: () => ctx.fiber.dispose(),
  }
}

/**
 * Wait until no entry is still pending, or give up and report which are.
 *
 * A pending entry is the honest signal of a missing service, and a caller that
 * reported success while something sat pending would be reporting a tree that
 * never finished loading.
 */
export async function settle(ctx: Context, timeoutMs = 5_000): Promise<readonly string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pending = [...ctx.loader.entries()]
      .filter((entry) => entry.fiber !== undefined && entry.fiber.state === 0)
      .map((entry) => entry.options.id)
    if (pending.length === 0 || Date.now() > deadline) return pending
    await new Promise((done) => setTimeout(done, 20))
  }
}
