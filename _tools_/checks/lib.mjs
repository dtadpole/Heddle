import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * Helpers shared by the verifiers in `_verifiers_/`.
 *
 * Two rules are carried by this file, and both come from `ULTIMATE_GOAL.md`:
 *
 * - **Nothing here spends anything.** Every check runs against this checkout,
 *   with a substituted provider where a model would otherwise be called, and
 *   never against a paid endpoint.
 * - **A check that cannot judge says so.** `skipUnless` turns "the mechanism
 *   this part is about does not exist yet" into a labelled skip, which the
 *   runner counts as unjudged (exit `3`) rather than as a pass.
 */

/** Repository root, derived from this file so a check can be run from anywhere. */
export const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** Where the checks write their fixtures. Never inside the repository. */
export function tempDir(prefix = 'heddle-verify-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Remove a fixture directory, ignoring the case where it never appeared. */
export function removeDir(path) {
  rmSync(path, { recursive: true, force: true })
}

/** Every file under `dir`, relative to it and sorted, or `[]` when it is absent. */
export function listFiles(dir) {
  if (!existsSync(dir)) return []
  const found = []
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(join(current, entry.name), next)
      else found.push(next)
    }
  }
  walk(dir, '')
  return found.sort()
}

/**
 * Run one command and capture it whole.
 *
 * A timeout is a judgement, not an error: a run that hangs cannot satisfy any
 * part, so it is reported as a failure of that check with the partial output
 * attached.
 */
export async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
  })

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const timeoutMs = options.timeoutMs ?? 20_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)

  const code = await new Promise((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('close', resolvePromise)
  })
  clearTimeout(timer)

  return { code, stdout, stderr, timedOut, failed: timedOut || code !== 0 }
}

/** Spawn a process without waiting for it, so a transcript can be read mid-run. */
export function start(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
  })
}

/** Wait until `predicate` is true, or give up. Returns whether it became true. */
export async function waitFor(predicate, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
}

/**
 * Skip a check when the mechanism it judges is not built yet.
 *
 * `context.skip(reason)` marks it unjudged, which is the honest verdict for a
 * part whose subject does not exist: it is not a pass, and it is not a failure
 * of the part either.
 */
export function skipUnless(context, condition, reason) {
  if (!condition) context.skip(reason)
  return Boolean(condition)
}

/** Does this checkout declare a dependency, in either dependencies section? */
export function hasDependency(name) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name])
}

/**
 * The plugin labels a run reported, read from the CLI's own output.
 *
 * The shape is the one `src/cli.ts` writes: a count line, then one indented line
 * per registered plugin. Reading it from the output rather than from the source
 * is deliberate — the claim is about what a *run* loaded.
 */
export function loadedPlugins(stdout) {
  return stdout
    .split('\n')
    .filter((line) => /^\s{2}\S/.test(line))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && name !== 'fiber(s)')
}

/** The plugin count a run reported, or `null` when it said nothing usable. */
export function loadedCount(stdout) {
  const match = /heddle: (\d+) plugin\(s\) loaded/.exec(stdout)
  return match ? Number(match[1]) : null
}

/** Run the CLI from source and capture what it printed. */
export function runCli(args, options = {}) {
  return run(process.execPath, ['src/cli.ts', ...args], { cwd: repoRoot, ...options })
}

/** Where DSH keeps session buckets, one directory per working directory. */
export const sessionRoot = join(process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'), 'sessions')

/**
 * A cheap fingerprint of the session store, for before-and-after comparison.
 *
 * Counting files rather than listing them keeps the walk short, and that matters
 * because the store is large. It answers "did this run record anything" without
 * claiming which record is which.
 */
export function sessionFingerprint(root = sessionRoot) {
  const buckets = existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []
  let sessions = 0
  let newestMtime = 0
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue
    for (const entry of readdirSync(join(root, bucket.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      sessions += 1
      const files = readdirSync(join(root, bucket.name, entry.name), { withFileTypes: true })
      for (const file of files) {
        if (file.isFile() && file.name.startsWith('session.')) {
          const stats = statSyncSafe(join(root, bucket.name, entry.name, file.name))
          if (stats && stats.mtimeMs > newestMtime) newestMtime = stats.mtimeMs
        }
      }
    }
  }
  return { sessions, newestMtime }
}

function statSyncSafe(path) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/**
 * The environment variable that makes a model provider substitutable.
 *
 * The framework's contract, not this harness's convenience: a provider that
 * honours it can be pointed at a local double, which is what lets the model and
 * end-to-end parts be judged without spending the owner's credentials. Nothing
 * in `src/` reads it yet; the tests that use it are how the contract becomes
 * observable.
 */
export const PROVIDER_ENV = 'HEDDLE_PROVIDER_BASE_URL'

/** Is there a tool whose registration `run` output shows as a named tool? */
export function mentionsAny(text, needles) {
  return needles.some((needle) => text.includes(needle))
}
