#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { createApp } from './app.ts'
import { boot, settle } from './boot.ts'

/**
 * `FiberState` is a `const enum`, so it has no runtime object to read names from.
 * The numbers are the declaration order in cordis `src/fiber.ts`.
 */
const STATES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const

interface Args {
  punctuation?: string
  target?: string
  quiet: boolean
  help: boolean
  config?: string
  patch: string[]
  turn?: string
  resume?: string
  list: boolean
  json: boolean
  command?: string
}

const USAGE = `heddle — a harness and agent framework built on Cordis

usage: heddle [options] [command]

options:
  -c, --config <path>       boot from this configuration layer instead of the default profile
      --patch <path>        apply an extra layer after it (repeatable)
      --turn <text>         send one turn to the session and print the answer
      --resume <id>         continue an existing session rather than starting one
      --list                list what is registered, then stop
      --json                print machine-readable output
  -p, --punctuation <mark>  punctuation the greeting service appends (default !)
  -t, --target <name>       who the run is for (default heddle)
  -q, --quiet               do not attach the console exporter
  -h, --help                show this message

commands:
  tools                     list the registered tools
  commands                  list the registered commands
  config                    print the composed configuration tree

Without a configuration flag, heddle boots the profile in ./cordis.yml plus
./heddle.patch.yml.
`

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { quiet: false, help: false, patch: [], list: false, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const next = () => argv[++index]
    switch (arg) {
      case '-p':
      case '--punctuation':
        args.punctuation = next()
        break
      case '-t':
      case '--target':
        args.target = next()
        break
      case '-c':
      case '--config':
        args.config = next()
        break
      case '--patch':
        args.patch.push(next() ?? '')
        break
      case '--turn':
        args.turn = next()
        break
      case '--resume':
        args.resume = next()
        break
      case '--list':
        args.list = true
        break
      case '--json':
        args.json = true
        break
      case '-q':
      case '--quiet':
        args.quiet = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      case 'tools':
      case 'commands':
      case 'config':
        args.command = arg
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

interface RegistryView {
  readonly registry: Map<unknown, { name?: string; fibers: Set<{ state: number }> }>
}

/**
 * Machinery a profile always loads, so it is not counted as a configured plugin.
 *
 * Named here rather than filtered by name in the check, because the check's claim
 * is "the tree is what the file declares": a run whose count included these two
 * would report the same number for two different files, which is exactly the
 * false pass the count exists to prevent. Measured while writing the first
 * version of this command.
 */
const REGISTRY_INFRASTRUCTURE = new Set(['Loader', 'isolate'])

/**
 * What to call a loaded plugin.
 *
 * The **configured id** when the loader owns the plugin, because that is the name
 * a reader of the configuration file used and therefore the name a check can
 * assert on. Falling back to the runtime name, then the package's `name` export,
 * covers a plugin loaded in code rather than from a layer.
 */
function labelOf(entry: [unknown, { name?: string; fibers: Set<object> }], loader?: LoaderLike): string {
  const [callback, runtime] = entry
  const fiber = [...runtime.fibers][0]
  const owned = fiber && loader ? loader.locate(fiber as never) : undefined
  if (owned) {
    const resolved = loader?.resolve(owned)
    if (resolved?.options?.id) return resolved.options.id
  }
  return runtime.name ?? (callback as { name?: string }).name ?? '(anonymous)'
}

interface LoaderLike {
  locate(fiber: never): string | undefined
  resolve(id: string): { options?: { id?: string } } | undefined
}

function printTree(ctx: RegistryView & { loader?: LoaderLike }): void {
  const entries = [...ctx.registry.entries()].filter(
    ([callback, runtime]) => !REGISTRY_INFRASTRUCTURE.has(runtime.name ?? (callback as { name?: string }).name ?? ''),
  )
  process.stdout.write(`heddle: ${entries.length} plugin(s) loaded\n`)
  for (const entry of entries) {
    const [, runtime] = entry
    const fibers = [...runtime.fibers]
    const states = fibers.map((fiber) => STATES[fiber.state] ?? `unknown(${fiber.state})`).join(', ')
    const label = labelOf(entry, ctx.loader)
    process.stdout.write(`  ${label.padEnd(16)} ${fibers.length} fiber(s)  ${states}\n`)
  }
}

/** Boot from the default profile or from the flags. */
async function bootFromArgs(args: Args) {
  const defaultBase = resolve(process.cwd(), 'cordis.yml')
  const useDefaultProfile = args.config === undefined && existsSync(defaultBase)
  return boot({
    configDir: process.cwd(),
    ...(args.config !== undefined
      ? { base: args.config, patches: args.patch }
      : useDefaultProfile
        ? { base: defaultBase, patches: args.patch }
        : {}),
  })
}

function hasProfile(args: Args): boolean {
  return args.config !== undefined || args.patch.length > 0 || existsSync(resolve(process.cwd(), 'cordis.yml'))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return
  }

  if (hasProfile(args)) {
    const app = await bootFromArgs(args)
    try {
      const pending = await settle(app.ctx)
      printTree(app.ctx as unknown as RegistryView & { loader?: LoaderLike })
      if (pending.length > 0) {
        process.stdout.write(`heddle: ${pending.length} entry(ies) still pending: ${pending.join(', ')}\n`)
        process.exitCode = 1
      }
    } finally {
      await app.dispose()
    }
    return
  }

  const app = await createApp(args)
  const { ctx } = app
  printTree(ctx as unknown as RegistryView)
  ctx.emit('heddle/ready', app.target)
  await app.dispose()
}

try {
  await main()
} catch (error) {
  process.stderr.write(`heddle: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
