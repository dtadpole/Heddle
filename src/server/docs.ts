import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * Where the documents a right-hand view can show come from.
 *
 * One root, a bounded walk, and a path check on every read — because a document view that can be asked for
 * `../../.ssh/id_rsa` is a file-disclosure hole with a rendering front end. The rules are stated here rather
 * than in the route so they can be judged without a server:
 *
 * - **The root is fixed.** Everything below it is reachable; nothing beside it is.
 * - **The walk skips what is not a person's documents** — dependency trees, VCS metadata, build output — and
 *   stops at a bound, so a large checkout cannot make the listing unbounded work.
 * - **A path is resolved and then checked to be inside the root**, by path segment and not by string prefix,
 *   so a sibling directory whose name starts with the root's name is not mistaken for the root.
 */

/** Directories a person's documents are never in, and which would otherwise dominate a listing. */
const SKIP = new Set(['node_modules', '.git', 'dist', '.heddle-tmp', '.venv', 'coverage', '.next', 'build'])

/** What counts as a document. */
const MARKDOWN = /\.(?:md|markdown|mdx)$/i

/** How many documents a listing may hold, and how deep it may look. */
const MAX_DOCS = 200
const MAX_DEPTH = 6
/** How much of one document may be read and rendered. */
export const MAX_DOC_BYTES = 512 * 1024

/** One document, as the listing describes it. */
export interface DocEntry {
  /** The path relative to the root, which is what a caller asks for. */
  readonly path: string
  readonly bytes: number
}

/** Whether `child` is `root` or inside it, compared by path segment. */
export function isInside(root: string, child: string): boolean {
  const base = resolve(root)
  const target = resolve(child)
  if (target === base) return true
  return target.startsWith(base + sep)
}

/**
 * Every markdown file below `root`, newest first is not wanted here — a **stable** order is, so a listing does
 * not reshuffle between reads. Sorted by path.
 */
export function findDocs(root: string, options: { readonly max?: number; readonly depth?: number } = {}): readonly DocEntry[] {
  const max = options.max ?? MAX_DOCS
  const maxDepth = options.depth ?? MAX_DEPTH
  const found: DocEntry[] = []

  const walk = (directory: string, depth: number): void => {
    if (found.length >= max || depth > maxDepth) return
    let entries: readonly string[]
    try {
      entries = readdirSync(directory)
    } catch {
      /** An unreadable directory is not a failure: it contributes nothing and the walk continues. */
      return
    }
    for (const name of entries) {
      if (found.length >= max) return
      if (name.startsWith('.') && name !== '.') continue
      const full = join(directory, name)
      let stats
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        if (SKIP.has(name)) continue
        walk(full, depth + 1)
        continue
      }
      if (!stats.isFile() || !MARKDOWN.test(name)) continue
      found.push({ path: relative(root, full).split(sep).join('/'), bytes: stats.size })
    }
  }

  walk(resolve(root), 0)
  return found.sort((left, right) => left.path.localeCompare(right.path))
}

/** The document at a caller-supplied path, or a refusal that says which rule it broke. */
export function readDoc(root: string, path: string): { readonly text: string } | { readonly error: string } {
  if (path.length === 0) return { error: 'a path is required' }
  const target = resolve(root, path)
  if (!isInside(root, target)) return { error: 'that path is outside the document root' }
  if (!MARKDOWN.test(target)) return { error: 'only a markdown document can be read here' }
  try {
    const stats = statSync(target)
    if (!stats.isFile()) return { error: 'not a file' }
    if (stats.size > MAX_DOC_BYTES) return { error: `the document is larger than ${MAX_DOC_BYTES} bytes` }
    return { text: readFileSync(target, 'utf8') }
  } catch {
    return { error: 'no such document' }
  }
}
