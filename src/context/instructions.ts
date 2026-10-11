import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * The instruction baseline: the project's own rules, delivered as one durable message.
 *
 * Modelled on `@deepseek-ai/dsh-agent-instructions`, including the parts that took reading the code
 * to believe:
 *
 * - **One message, not one per file.** A baseline is a single user-role message carrying a
 *   `<system-reminder>` frame and every file in it, so a reader sees one block of instructions and
 *   the surface gains one node when it changes.
 * - **The byte budget drops whole files before it truncates one.** Broader files go first and the
 *   most specific file is the only one ever cut, because the nearest file is the one that knows
 *   about this directory. The omissions are named in the message rather than silently missing.
 * - **A file is found by climbing until a marker is present.** The chain is the user-global file
 *   followed by every file from the repository root down to the working directory — broadest first,
 *   which is also the order the budget drops in.
 * - **An unchanged baseline is not re-sent.** The rendered batch carries a digest, and the caller
 *   compares it, so re-reading a project's rules after every tool call costs a hash rather than a
 *   message.
 */

/** The largest rendered baseline, counted in UTF-8 bytes. DSH's standard preset uses the same. */
export const INSTRUCTIONS_MAX_BYTES = 65536

/** The files a project's rules may live in, most common first. */
export const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const

/** A local overlay of a file above, which wins for the directory it sits in. */
export const LOCAL_INSTRUCTION_FILE_NAMES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const

const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

/** One instruction file, read whole. */
export interface InstructionFile {
  readonly path: string
  readonly text: string
}

/** A rendered baseline: the text, what went in, and what the budget left out. */
export interface InstructionBaseline {
  readonly text: string
  readonly included: readonly string[]
  readonly omitted: readonly string[]
  readonly truncated: boolean
  /** A digest of the rendered text, which is what a caller compares to decide to re-send. */
  readonly identity: string
}

/**
 * The ancestor directory that owns the project, or `undefined` when there is no marker.
 *
 * The walk climbs while the marker is **absent** and stops at the first directory that has one,
 * which is the nearest repository root. An unreadable probe is not a failure: a `.git` that cannot
 * be stat'ed means this directory is not the root, and the walk continues.
 */
export function findProjectRoot(cwd: string, markers: readonly string[] = ['.git']): string | undefined {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      try {
        readFileSync(join(current, marker))
        return current
      } catch {
        // a `.git` directory rather than a file: the usual case, and not readable as a file
        try {
          if (readFileSync(join(current, marker, 'HEAD'), 'utf8').length > 0) return current
        } catch {
          // keep walking
        }
      }
    }
    const parent = resolve(current, '..')
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * The instruction files that apply to a working directory, broadest first.
 *
 * The user-global file comes first because it applies everywhere, then every file from the
 * repository root down to `cwd`. Without a repository marker the walk still produces `cwd` itself,
 * so a directory of notes is not silently ignored.
 */
export function findInstructionFiles(
  cwd: string,
  options: { readonly home?: string; readonly markers?: readonly string[] } = {},
): readonly InstructionFile[] {
  const home = options.home ?? process.env.HEDDLE_HOME ?? join(homedir(), '.heddle')
  const found: InstructionFile[] = []

  const global = join(home, 'AGENTS.md')
  try {
    found.push({ path: global, text: readFileSync(global, 'utf8') })
  } catch {
    // no user-global rules, which is the normal case on a fresh machine
  }

  const resolved = resolve(cwd)
  const root = findProjectRoot(resolved, options.markers ?? ['.git']) ?? resolved
  const chain: string[] = []
  let current = resolved
  for (;;) {
    chain.push(current)
    if (current === root) break
    const parent = resolve(current, '..')
    if (parent === current) break
    current = parent
  }

  for (const directory of [...chain].reverse()) {
    for (const name of [...INSTRUCTION_FILE_NAMES, ...LOCAL_INSTRUCTION_FILE_NAMES]) {
      const path = join(directory, name)
      try {
        found.push({ path, text: readFileSync(path, 'utf8') })
      } catch {
        continue
      }
    }
  }
  return found
}

/** A digest of content with surrounding whitespace ignored, so a copy that differs only in spacing collapses. */
export function instructionDigest(text: string): string {
  return createHash('sha1').update(text.trim()).digest('hex')
}

/**
 * Render the files into one baseline, applying the byte budget the way DSH applies it.
 *
 * Dropping starts at the **broad** end: a user-global file is the first to go, then the repository
 * root's, and the file nearest the working directory is the only one that may be truncated. What
 * was dropped is named in the notice, because a model that cannot see a rule should be able to say
 * that a rule was left out rather than guess that none existed.
 */
export function renderInstructionBaseline(
  files: readonly InstructionFile[],
  maxBytes: number = INSTRUCTIONS_MAX_BYTES,
): InstructionBaseline {
  const included = [...files]
  const omitted: string[] = []
  let truncated = false

  const size = (entries: readonly InstructionFile[]): number =>
    entries.reduce((total, entry) => total + Buffer.byteLength(entry.text, 'utf8'), 0)

  const noticeBytes = 200
  while (included.length > 1 && size(included) + noticeBytes > maxBytes) {
    const dropped = included.shift()
    if (dropped !== undefined) omitted.push(dropped.path)
  }

  const last = included[included.length - 1]
  if (last !== undefined && size(included) + noticeBytes > maxBytes) {
    const allowance = Math.max(0, maxBytes - noticeBytes - size(included.slice(0, -1)))
    const bytes = Buffer.from(last.text, 'utf8').subarray(0, allowance)
    included[included.length - 1] = { path: last.path, text: `${bytes.toString('utf8')}\n… [truncated to fit the instruction budget]` }
    truncated = true
  }

  const body = included
    .map((file) => `# ${displayPath(file.path)}\n\n${file.text.trim()}`)
    .join('\n\n')
  const notice = markerText(maxBytes, omitted, truncated)
  const text = `${REMINDER_OPEN}\n${notice}\n\n${body}\n${REMINDER_CLOSE}`

  return {
    text,
    included: included.map((file) => file.path),
    omitted,
    truncated,
    identity: instructionDigest(text),
  }
}

/** The one line that says what the budget did, or nothing when it had to do nothing. */
function markerText(maxBytes: number, omitted: readonly string[], truncated: boolean): string {
  if (omitted.length === 0 && !truncated) {
    return 'The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or user instructions.'
  }
  const parts: string[] = []
  if (omitted.length > 0) parts.push(`omitted whole: ${omitted.map(displayPath).join(', ')}`)
  if (truncated) parts.push('the last file was truncated')
  return `The following workspace instructions may be relevant to your work.\n\nWorkspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}.`
}

/** A path a reader recognises: home-relative for the user-global file, absolute otherwise. */
function displayPath(path: string): string {
  const home = homedir()
  return isAbsolute(path) && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
