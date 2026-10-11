#!/usr/bin/env node
import { createApp } from './app.ts'

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
}

const USAGE = `heveld — a harness and agent framework built on Cordis

usage: heveld [options]

options:
  -p, --punctuation <mark>  punctuation the greeting service appends (default !)
  -t, --target <name>       who the run is for (default heveld)
  -q, --quiet               do not attach the console exporter
  -h, --help                show this message
`

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { quiet: false, help: false }
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
      case '-q':
      case '--quiet':
        args.quiet = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return
  }

  const app = await createApp(args)
  const { ctx } = app

  process.stdout.write(`heveld: ${ctx.registry.size} plugin(s) loaded\n`)
  for (const [callback, runtime] of ctx.registry.entries()) {
    const fibers = [...runtime.fibers]
    const states = fibers.map((fiber) => STATES[fiber.state] ?? `unknown(${fiber.state})`).join(', ')
    const label = runtime.name ?? (callback.name || '(anonymous)')
    process.stdout.write(`  ${label.padEnd(16)} ${fibers.length} fiber(s)  ${states}\n`)
  }

  ctx.emit('heveld/ready', app.target)
  await app.dispose()
}

try {
  await main()
} catch (error) {
  process.stderr.write(`heveld: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
