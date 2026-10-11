import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { hasDependency, loadedCount, loadedPlugins, repoRoot, runCli, skipUnless } from '../../_tools_/checks/lib.mjs'

/**
 * Verifier 1 — configuration-driven.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: a run loads its plugin tree from a
 * configuration file rather than from a list compiled into the source. The
 * fixture below declares a plugin set that shares nothing with the scaffold's
 * hardcoded one, and that is the point: a run that reports this set can only
 * have read the file.
 *
 * Fixtures are `.ts` files under a scratch directory inside the repository, and
 * they are removed when the check finishes. Two measured reasons, both of which
 * cost a round while writing this: Node strips TypeScript types by extension, so
 * a fixture named `.mjs` cannot contain `static readonly`; and the loader imports
 * the fixture by absolute path, so the fixture must sit somewhere Node can also
 * resolve `@deepseek-ai/cordis` from — a directory under `/tmp` cannot.
 */

const scratch = join(repoRoot, '.heddle-tmp')
const CAPABILITY = 'the config-driven boot (a --config flag plus a loader that reads a YAML tree)'
const hasMechanism = () => hasDependency('@deepseek-ai/cordis-plugin-loader')

let counter = 0
function fixtureDir(label) {
  const dir = join(scratch, `${label}-${(counter += 1)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A two-plugin tree whose names share nothing with the scaffold's, plus one
 * child so a flat list cannot satisfy the check by accident. `alpha` provides a
 * service and `beta` injects it, which also exercises the activation rule.
 */
function writeFixture(label = 'config') {
  const dir = fixtureDir(label)
  writeFileSync(
    join(dir, 'alpha.ts'),
    `import { Service } from '@deepseek-ai/cordis'

export const name = 'alpha'

export default class Alpha extends Service {
  static readonly provide = 'alpha'
  private readonly label: string
  constructor(ctx: any, config: { label?: string } = {}) {
    super(ctx, 'alpha')
    this.label = config.label ?? 'unset'
  }
  answer(): string {
    return 'alpha:' + this.label
  }
}
`,
  )
  writeFileSync(
    join(dir, 'beta.ts'),
    `export const name = 'beta'
export const inject = ['alpha']
export default function beta(ctx: any, config: { n?: number } = {}) {
  ctx.on('heddle/ready', () => {
    process.stdout.write('beta saw ' + ctx.alpha.answer() + ' n=' + config.n + '\\n')
  })
}
`,
  )
  writeFileSync(
    join(dir, 'gamma.ts'),
    `export const name = 'gamma'
export default function gamma() {}
`,
  )
  writeFileSync(
    join(dir, 'heddle.yml'),
    `- insert:
    - id: alpha
      name: ./alpha.ts
      config:
        label: from-config
    - id: beta
      name: ./beta.ts
      inject: [alpha]
      config:
        n: 2
    - id: gamma
      name: ./gamma.ts
`,
  )
  return dir
}

test('a run boots from a configuration file and no other source', async (context) => {
  if (!skipUnless(context, hasMechanism(), CAPABILITY)) return
  const dir = writeFixture()
  const result = await runCli(['--config', join(dir, 'heddle.yml')])
  assert.equal(result.timedOut, false, `the run did not finish\n${result.stdout}${result.stderr}`)
  assert.equal(result.code, 0, `the run failed\n${result.stdout}${result.stderr}`)

  const loaded = loadedPlugins(result.stdout)
  assert.deepEqual(
    new Set(loaded),
    new Set(['alpha', 'beta', 'gamma']),
    `the loaded set is exactly what the file declares, nothing else\nloaded: ${loaded.join(', ')}`,
  )
})

test('two configurations load two different trees', async (context) => {
  if (!skipUnless(context, hasMechanism(), CAPABILITY)) return
  const dir = writeFixture()
  writeFileSync(
    join(dir, 'heddle-small.yml'),
    `- insert:
    - id: alpha
      name: ./alpha.ts
`,
  )
  const full = await runCli(['--config', join(dir, 'heddle.yml')])
  const small = await runCli(['--config', join(dir, 'heddle-small.yml')])
  assert.equal(small.code, 0, `the smaller configuration did not boot\n${small.stdout}${small.stderr}`)

  const fullCount = loadedCount(full.stdout)
  const smallCount = loadedCount(small.stdout)
  assert.notEqual(fullCount, smallCount, 'the tree follows the file rather than a compiled-in list')
  assert.equal(smallCount, 1, `the one-plugin file loaded one plugin\n${small.stdout}`)
})

test('config values reach the plugins that declared them', async (context) => {
  if (!skipUnless(context, hasMechanism(), CAPABILITY)) return
  const dir = writeFixture()
  const result = await runCli(['--config', join(dir, 'heddle.yml')])
  assert.match(
    result.stdout,
    /beta saw alpha:from-config n=2/,
    `the values in the file reached the plugins, and the injected service was there to read\n${result.stdout}${result.stderr}`,
  )
})

test('a later layer restates one row without touching the rest', async (context) => {
  if (!skipUnless(context, hasMechanism(), CAPABILITY)) return
  const dir = writeFixture()
  writeFileSync(
    join(dir, 'override.yml'),
    `- patch:
    - id: alpha
      config:
        label: from-the-override
`,
  )
  const result = await runCli(['--config', join(dir, 'heddle.yml'), '--patch', join(dir, 'override.yml')])
  assert.equal(result.code, 0, `the layered run failed\n${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /alpha:from-the-override/, `the last write won\n${result.stdout}`)
  assert.equal(loadedCount(result.stdout), 3, 'the other rows were left alone')
})

test('an unknown flag is refused rather than ignored', async (context) => {
  if (!skipUnless(context, hasMechanism(), CAPABILITY)) return
  const result = await runCli(['--config-definitely-not-a-flag'], { cwd: repoRoot })
  assert.notEqual(result.code, 0, 'the command line does not silently accept what it does not understand')
})

test('a patch that names a row no layer inserted is refused', async (context) => {
  if (!skipUnless(context, hasMechanism(), CAPABILITY)) return
  const dir = fixtureDir('config-bad-patch')
  writeFileSync(
    join(dir, 'a.yml'),
    `- insert:
    - id: alpha
      name: ./alpha.ts
- patch:
    - id: nowhere
      config: {}
`,
  )
  const result = await runCli(['--config', join(dir, 'a.yml')])
  assert.notEqual(result.code, 0, `a patch against a missing row fails where the layer is read\n${result.stdout}`)
  assert.match(result.stderr + result.stdout, /nowhere/, 'the failure names the row it could not find')
})
