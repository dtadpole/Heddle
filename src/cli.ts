#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createApp } from './app.ts'
import { boot, settle } from './boot.ts'
import { runTurn } from './agent/loop.ts'
import { describeEndpoint } from './endpoints.ts'
import { defaultSessionRoot } from './session/store.ts'
import { printStream } from './stream/printer.ts'
import { heddleHome } from './config/schema.ts'

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
  profile?: string
  patch: string[]
  turn?: string
  resume?: string
  endpoint?: string
  model?: string
  system?: string
  maxRounds?: number
  maxOutputTokens?: number
  sessionRoot?: string
  port?: number
  host?: string
  workspace?: string
  stream: boolean
  validate: boolean
  origins: boolean
  list: boolean
  json: boolean
  command?: string
}

const USAGE = `heddle — a harness and agent framework built on Cordis

usage: heddle [options] [command]

options:
  -c, --config <path>        boot from this configuration layer instead of the default profile
      --profile <name>       boot a named profile from $HEDDLE_HOME/profiles
      --patch <path>         apply an extra layer after it (repeatable)
      --turn <text>          run one agent turn and print the answer
      --resume <id>          continue an existing session rather than starting one
      --endpoint <name>      which configured endpoint answers (default: the first)
      --model <id>           override the endpoint's model for this turn
      --system <text>        system prompt, recorded when the session is new
      --max-rounds <n>       stop after n model-plus-tools rounds (default 8)
      --max-output-tokens <n>  cap the tokens one model call may generate
      --stream               print reasoning and content deltas to stderr as they arrive
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
  workspaces                 list the workspaces and their sessions
  context                    show the assembled context for a session, without calling a model
  hooks                      list the hook points this build emits
  web                        serve the Web UI on localhost
  transcript <id>            print a session's transcript
  profiles                   list the profiles this machine holds
  config                     print the composed tree, or validate it with --validate
      --validate             with the config command, check every row without starting it
      --origins              with the config command, show which layer supplied each field

Endpoint configuration lives outside the repository, in $HEDDLE_CONFIG,
$HEDDLE_HOME/heddle.json or ~/.heddle/heddle.json. Nothing here carries a URL or a
credential of its own.
`

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { quiet: false, help: false, patch: [], list: false, json: false, stream: false, validate: false, origins: false }
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
      case '--profile':
        args.profile = next()
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
      case '--port':
        args.port = Number(next())
        break
      case '--host':
        args.host = next()
        break
      case '--stream':
        args.stream = true
        break
      case '--validate':
        args.validate = true
        break
      case '--origins':
        args.origins = true
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
      case 'web':
      case 'workspaces':
      case 'context':
      case 'hooks':
      case 'profiles':
      case 'config':
        args.command = arg
        // Only `transcript` takes a positional argument. Consuming the next token for
        // every command is what made `heddle web --port 3099` fail with "unknown
        // argument: 3099": the command ate the flag that followed it. Measured while
        // first wiring the Web UI.
        if (arg === 'transcript') args.target = next() ?? undefined
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
    ...(args.profile !== undefined ? { profile: args.profile } : {}),
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
  return (
    args.profile !== undefined ||
    args.config !== undefined ||
    args.patch.length > 0 ||
    existsSync(resolve(process.cwd(), 'cordis.yml'))
  )
}

/**
 * The commands that answer without running a model.
 *
 * They exist before the turn does on purpose: `models` and `tools` are how a
 * person checks a configuration without spending anything, and a harness whose
 * first usable command costs money is one nobody configures carefully.
 */
async function runWeb(args: Args): Promise<void> {
  const { startWebServer, DEFAULT_PORT } = await import('./server/web.ts')
  const app = await bootFromArgs(args)
  try {
    const pending = await settle(app.ctx)
    if (pending.length > 0) throw new Error(`${pending.length} entr(y/ies) are still pending: ${pending.join(', ')}`)
    const server = await startWebServer(app.ctx, {
      ...(args.port !== undefined ? { port: args.port } : { port: DEFAULT_PORT }),
      ...(args.host !== undefined ? { host: args.host } : {}),
    })
    process.stdout.write(`heddle web: ${server.url}\n`)
    process.stdout.write(`heddle web: serving on ${server.host}:${server.port}; pass --port to change it\n`)
    if (args.json) process.stdout.write(`${JSON.stringify({ url: server.url, host: server.host, port: server.port, token: server.token })}\n`)
    // Run until interrupted, which is the only honest lifetime for a server.
    await new Promise<void>((resolvePromise) => {
      const stop = () => {
        void server.close().then(resolvePromise)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
  } finally {
    await app.dispose()
  }
}

/**
 * Commands that answer from the configuration alone, without starting anything.
 *
 * `profiles`, `config` and `config --validate` must not boot: the question they answer is
 * what the tree *is*, and a command that started every plugin to describe them could not
 * be run on a tree that is broken — which is exactly when it is needed.
 */
async function runConfigCommand(command: string, args: Args): Promise<boolean> {
  const { compose, defaultLayers, listProfiles, originOf } = await import('./config/schema.ts')
  // The same defaulting the boot path uses, so `heddle config` describes the tree a bare
  // `heddle --turn` would run rather than an empty one. Measured: the first version had no
  // default here and reported "0 configured row(s)", which was true and useless.
  const projectBase = resolve(process.cwd(), 'cordis.yml')
  const named = args.profile !== undefined || args.config !== undefined || args.patch.length > 0
  const layers = defaultLayers({
    ...(args.profile !== undefined ? { profile: args.profile } : {}),
    ...(args.config !== undefined
      ? { base: args.config }
      : args.profile === undefined && existsSync(projectBase)
        ? { base: projectBase }
        : {}),
    patches: args.patch,
    includeProjectPatch: !named && args.profile === undefined,
    configDir: process.cwd(),
  })

  if (command === 'profiles') {
    const profiles = listProfiles()
    if (args.json) process.stdout.write(`${JSON.stringify(profiles, null, 2)}\n`)
    else {
      process.stdout.write(`heddle: ${profiles.length} profile(s) under ${join(heddleHome(), 'profiles')}\n`)
      for (const profile of profiles) process.stdout.write(`  ${profile.name.padEnd(18)} ${profile.layers.join(', ') || '(no layers)'}\n`)
    }
    return true
  }

  if (command === 'config' && args.validate) {
    const { validateRows } = await import('./config/validate.ts')
    const result = await validateRows(layers)
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else {
      process.stdout.write(`heddle: ${result.rows} row(s) checked, ${result.problems.length} problem(s)\n`)
      for (const problem of result.problems) process.stdout.write(`  ${problem}\n`)
    }
    if (result.problems.length > 0) process.exitCode = 1
    return true
  }

  if (command === 'config') {
    let rows
    try {
      rows = compose(layers)
    } catch (error) {
      process.stderr.write(`heddle: ${(error as Error).message}\n`)
      process.exitCode = 1
      return true
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(rows.map((entry) => ({ ...entry.row, position: entry.position, origins: entry.fields })), null, 2)}\n`)
      return true
    }
    process.stdout.write(`heddle: ${rows.length} configured row(s) from ${layers.map((layer) => layer.layer).join(' -> ')}\n`)
    for (const entry of rows) {
      const flags = [entry.row.disabled === true ? 'disabled' : '', entry.row.inject !== undefined ? `inject ${(entry.row.inject ?? []).join(',')}` : '']
        .filter((part) => part.length > 0)
        .join('  ')
      process.stdout.write(`  ${String(entry.row.id ?? '-').padEnd(16)} ${entry.row.name}${flags.length > 0 ? `  ${flags}` : ''}\n`)
      if (args.origins) {
        for (const origin of entry.fields) {
          process.stdout.write(`      ${origin.field.padEnd(28)} ${origin.layer}\n`)
        }
      }
    }
    if (!args.origins) {
      process.stdout.write('heddle: pass --origins to see which layer supplied each field\n')
    }
    return true
  }
  return false
}

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
    if (command === 'workspaces') {
      const records = app.ctx.workspace.list()
      const all = app.ctx.session.list()
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            records.map((record) => ({ ...record, sessions: app.ctx.workspace.sessions(record, all).map((meta) => meta.id) })),
            null,
            2,
          )}\n`,
        )
      } else {
        process.stdout.write(`heddle: ${records.length} workspace(s) in ${app.ctx.workspace.file}\n`)
        for (const record of records) {
          const sessions = app.ctx.workspace.sessions(record, all)
          process.stdout.write(`  ${record.title}  ${record.path}  ${sessions.length} session(s)\n`)
          for (const meta of sessions.slice(0, 5)) process.stdout.write(`    ${meta.id}  turns=${meta.turns}\n`)
        }
      }
      return true
    }
    if (command === 'hooks') {
      const points = [
        { name: 'agent/pre-step', mode: 'waterfall', what: 'before a round request is built; may replace messages or tools' },
        { name: 'model/request', mode: 'waterfall', what: 'before an adapter is chosen; may replace the request' },
        { name: 'model/stream', mode: 'waterfall', what: 'around the adapter stream; may yield its own chunks' },
        { name: 'tools/pre-execute', mode: 'waterfall', what: 'before a tool runs; may refuse it' },
        { name: 'tools/post-execute', mode: 'waterfall', what: 'after a tool runs; may replace the result' },
        { name: 'session/event', mode: 'emit', what: 'after an event reaches the session file' },
      ]
      if (json) process.stdout.write(`${JSON.stringify(points, null, 2)}\n`)
      else {
        process.stdout.write(`heddle: ${points.length} hook point(s)\n`)
        for (const point of points) process.stdout.write(`  ${point.name.padEnd(20)} ${point.mode.padEnd(10)} ${point.what}\n`)
      }
      return true
    }
    if (command === 'context') {
      const handle =
        target !== undefined && target.length > 0
          ? app.ctx.session.start({ resume: target })
          : app.ctx.session.start({ cwd: process.cwd() })
      const report = app.ctx.context.assemble({ session: handle, cwd: process.cwd(), tools: app.ctx.tools.describe() })
      if (json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              session: handle.id,
              messages: report.messages.length,
              estimatedTokens: report.estimatedTokens,
              thresholdTokens: report.thresholdTokens,
              contextWindow: report.contextWindow,
              pruned: report.pruned,
              compacted: report.compacted,
              instructions: report.instructions,
            },
            null,
            2,
          )}\n`,
        )
      } else {
        process.stdout.write(`heddle: ${report.messages.length} message(s), about ${report.estimatedTokens} token(s)\n`)
        process.stdout.write(`heddle: budget ${report.thresholdTokens} of ${report.contextWindow}; pruned ${report.pruned}; compacted ${report.compacted}\n`)
        for (const path of report.instructions) process.stdout.write(`  instruction ${path}\n`)
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

  if (args.command === 'web') {
    await runWeb(args)
    return
  }

  if (args.command === 'profiles' || args.command === 'config') {
    const handled = await runConfigCommand(args.command, args)
    if (handled) return
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
    // The live view, started before the turn so nothing that arrives is missed.
    const printer = args.stream ? printStream(app.ctx, { session: handle.id }) : null
    const result = await runTurn(app.ctx, {
      session: handle,
      endpoint,
      prompt: args.turn,
      ...(args.system !== undefined ? { system: args.system } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.maxRounds !== undefined ? { maxRounds: args.maxRounds } : {}),
      ...(args.maxOutputTokens !== undefined ? { maxOutputTokens: args.maxOutputTokens } : {}),
    })

    printer?.dispose()
    const streamed = printer?.summary()
    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            session: handle.id,
            ...(streamed !== undefined ? { stream: streamed } : {}),
            // What the context was: the estimate, the budget, what was pruned, whether a
            // compaction ran. Reported because a budget nobody can see is a budget nobody can
            // check, and the context check reads exactly this.
            ...(result.context !== undefined ? { context: result.context } : {}),
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
