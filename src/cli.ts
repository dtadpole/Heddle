#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { createApp } from './app.ts'
import { boot, settle } from './boot.ts'
import { runTurn } from './agent/loop.ts'
import { describeEndpoint } from './endpoints.ts'
import { defaultSessionRoot } from './session/store.ts'

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
  endpoint?: string
  model?: string
  system?: string
  maxRounds?: number
  maxOutputTokens?: number
  sessionRoot?: string
  list: boolean
  json: boolean
  command?: string
}

const USAGE = `heddle — a harness and agent framework built on Cordis

usage: heddle [options] [command]

options:
  -c, --config <path>        boot from this configuration layer instead of the default profile
      --patch <path>         apply an extra layer after it (repeatable)
      --turn <text>          run one agent turn and print the answer
      --resume <id>          continue an existing session rather than starting one
      --endpoint <name>      which configured endpoint answers (default: the first)
      --model <id>           override the endpoint's model for this turn
      --system <text>        system prompt, recorded when the session is new
      --max-rounds <n>       stop after n model-plus-tools rounds (default 8)
      --max-output-tokens <n>  cap the tokens one model call may generate
      --list                 list what is registered, then stop
      --json                 print machine-readable output
  -p, --punctuation <mark>   punctuation the greeting service appends (default !)
  -t, --target <name>        who the run is for (default heddle)
  -q, --quiet                do not attach the console exporter
  -h, --help                 show this message

commands:
  models                     list the configured endpoints, without calling any
  tools                      list the registered tools
  commands                   list the registered commands
  sessions                   list the sessions this store holds
  transcript <id>            print a session's transcript
  config                     print the composed configuration tree

Endpoint configuration lives outside the repository, in $HEDDLE_CONFIG,
$HEDDLE_HOME/heddle.json or ~/.heddle/heddle.json. Nothing here carries a URL or a
credential of its own.
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
      case '--endpoint':
        args.endpoint = next()
        break
      case '--model':
        args.model = next()
        break
      case '--system':
        args.system = next()
        break
      case '--max-rounds':
        args.maxRounds = Number(next())
        break
      case '--max-output-tokens':
        args.maxOutputTokens = Number(next())
        break
      case '--session-root':
        args.sessionRoot = next()
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
      case 'models':
      case 'tools':
      case 'commands':
      case 'sessions':
      case 'transcript':
      case 'config':
        args.command = arg
        args.target = next() ?? undefined
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

interface LoaderLike {
  locate(fiber: never): string | undefined
  resolve(id: string): { options?: { id?: string } } | undefined
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

function pluginEntries(ctx: RegistryView): [unknown, { name?: string; fibers: Set<{ state: number }> }][] {
  return [...ctx.registry.entries()].filter(
    ([callback, runtime]) => !REGISTRY_INFRASTRUCTURE.has(runtime.name ?? (callback as { name?: string }).name ?? ''),
  )
}

function printTree(ctx: RegistryView & { loader?: LoaderLike }): void {
  const entries = pluginEntries(ctx)
  process.stdout.write(`heddle: ${entries.length} plugin(s) loaded\n`)
  for (const entry of entries) {
    const [, runtime] = entry
    const fibers = [...runtime.fibers]
    const states = fibers.map((fiber) => STATES[fiber.state] ?? `unknown(${fiber.state})`).join(', ')
    process.stdout.write(`  ${labelOf(entry, ctx.loader).padEnd(16)} ${fibers.length} fiber(s)  ${states}\n`)
  }
}

/** The base layer a run uses: the flag if given, else the profile beside the project. */
function baseLayer(args: Args): { readonly base?: string; readonly patches: readonly string[]; readonly includeProjectPatch: boolean } {
  const defaultBase = resolve(process.cwd(), 'cordis.yml')
  if (args.config !== undefined) return { base: args.config, patches: args.patch, includeProjectPatch: args.patch.length === 0 }
  if (existsSync(defaultBase)) return { base: defaultBase, patches: args.patch, includeProjectPatch: args.patch.length === 0 }
  return { patches: args.patch, includeProjectPatch: false }
}

/** Boot from the default profile or from the flags. **/
async function bootFromArgs(args: Args) {
  const layers = baseLayer(args)
  return boot({
    configDir: process.cwd(),
    ...(layers.base !== undefined ? { base: layers.base } : {}),
    patches: [...layers.patches],
    includeProjectPatch: layers.includeProjectPatch,
    // Restates the session row rather than reaching past the configuration: the
    // override is a layer, which is how every other override in this project works.
    ...(args.sessionRoot !== undefined
      ? { overrides: [{ patch: [{ id: 'session', config: { root: resolve(args.sessionRoot) } }] }] }
      : {}),
  })
}

function hasProfile(args: Args): boolean {
  return args.config !== undefined || args.patch.length > 0 || existsSync(resolve(process.cwd(), 'cordis.yml'))
}

/**
 * The commands that answer without running a model.
 *
 * They exist before the turn does on purpose: `models` and `tools` are how a
 * person checks a configuration without spending anything, and a harness whose
 * first usable command costs money is one nobody configures carefully.
 */
async function runCommand(command: string, target: string | undefined, json: boolean, args: Args): Promise<boolean> {
  const app = await bootFromArgs(args)
  try {
    if (command === 'models') {
      const endpoints = app.ctx.model.list().map(describeEndpoint)
      if (json) process.stdout.write(`${JSON.stringify(endpoints, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${endpoints.length} endpoint(s)\n`)
        for (const endpoint of endpoints) {
          const credential = endpoint.credential ?? endpoint.credentialFile ? ' credential' : ''
          process.stdout.write(
            `  ${String(endpoint.name).padEnd(18)} ${String(endpoint.kind).padEnd(16)} ${String(endpoint.model ?? '-')}${credential}\n`,
          )
        }
      }
      return true
    }
    if (command === 'tools') {
      const tools = app.ctx.tools.describe().map((tool) => ({ name: tool.name, description: tool.description }))
      if (json) process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${tools.length} tool(s)\n`)
        for (const tool of tools) process.stdout.write(`  ${tool.name.padEnd(14)} ${tool.description.split('.')[0]}\n`)
      }
      return true
    }
    if (command === 'commands') {
      const commands = app.ctx.tools.describeCommands()
      if (json) process.stdout.write(`${JSON.stringify(commands, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${commands.length} command(s)\n`)
        for (const entry of commands) process.stdout.write(`  ${entry.name.padEnd(14)} — ${entry.description}\n`)
      }
      return true
    }
    if (command === 'sessions') {
      const sessions = app.ctx.session.list()
      if (json) process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${sessions.length} session(s) in ${defaultSessionRoot()}\n`)
        for (const meta of sessions.slice(0, 20)) {
          process.stdout.write(`  ${meta.id}  ${meta.created}  turns=${meta.turns}  ${meta.title ?? ''}\n`)
        }
      }
      return true
    }
    if (command === 'transcript') {
      if (target === undefined) throw new Error('transcript needs a session id')
      const handle = app.ctx.session.start({ resume: target })
      for (const event of app.ctx.session.events(handle)) process.stdout.write(`${JSON.stringify(event)}\n`)
      return true
    }
    if (command === 'config') {
      const rows = app.rows
      if (json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${rows.length} configured row(s)\n`)
        for (const row of rows) process.stdout.write(`  ${String(row.id ?? '-').padEnd(16)} ${row.name}\n`)
      }
      return true
    }
    return false
  } finally {
    await app.dispose()
  }
}

function hasProfileArgs(args: Args): boolean {
  return hasProfile(args)
}

/** Fill in the flags `runCommand` does not read from the caller. */
function emptyArgs(args: Args): Args {
  return { ...args, command: undefined }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return
  }

  if (args.command !== undefined) {
    const handled = await runCommand(args.command, args.target, args.json, args)
    if (handled) return
  }

  if (!hasProfileArgs(args)) {
    const app = await createApp(args)
    const { ctx } = app
    printTree(ctx as unknown as RegistryView)
    ctx.emit('heddle/ready', app.target)
    await app.dispose()
    return
  }

  const app = await bootFromArgs(emptyArgs(args))
  try {
    const pending = await settle(app.ctx)
    if (pending.length > 0) {
      process.stdout.write(`heddle: ${pending.length} entry(ies) still pending: ${pending.join(', ')}\n`)
      process.exitCode = 1
      return
    }

    if (args.turn === undefined) {
      printTree(app.ctx as unknown as RegistryView & { loader?: LoaderLike })
      return
    }

    const endpoints = app.ctx.model.names()
    const endpoint = args.endpoint ?? endpoints[0]
    if (endpoint === undefined) throw new Error('no endpoint is configured; write ~/.heddle/heddle.json or pass --endpoint after configuring one')
    if (!endpoints.includes(endpoint)) throw new Error(`no endpoint named '${endpoint}'; configured: ${endpoints.join(', ')}`)

    const handle = app.ctx.session.start({
      ...(args.resume !== undefined ? { resume: args.resume } : {}),
      cwd: process.cwd(),
      endpoint,
      ...(args.model !== undefined ? { model: args.model } : {}),
      title: args.turn.slice(0, 60),
    })
    const result = await runTurn(app.ctx, {
      session: handle,
      endpoint,
      prompt: args.turn,
      ...(args.system !== undefined ? { system: args.system } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.maxRounds !== undefined ? { maxRounds: args.maxRounds } : {}),
      ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
    })

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            session: handle.id,
            endpoint,
            text: result.text,
            finishReason: result.finishReason,
            rounds: result.rounds,
            toolCalls: result.toolCalls.map((call) => ({ name: call.name, ok: call.result.error === undefined })),
            denials: result.denials,
            transcript: handle.transcript,
          },
          null,
          2,
        )}\n`,
      )
    } else {
      process.stdout.write(`${result.text}\n`)
      for (const call of result.toolCalls) {
        process.stdout.write(
          `heddle: tool ${call.name} ${call.result.error ? `refused (${call.result.error.code})` : 'ok'}\n`,
        )
      }
      for (const denial of result.denials) process.stdout.write(`heddle: denied ${denial.tool} — ${denial.message}\n`)
      process.stdout.write(`heddle: session ${handle.id} — ${handle.transcript}\n`)
    }
    if (result.denials.some((denial) => denial.code !== 'UNKNOWN_TOOL')) process.exitCode = 1
  } finally {
    await app.dispose()
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`heddle: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
