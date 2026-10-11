import { readdirSync } from 'node:fs'
import { basename, join, sep } from 'node:path'

import { canonicalPath, depthOf, isUnder } from '../paths.ts'
import type { SessionMeta } from './store.ts'

/**
 * The folder tree the Web UI's left column shows.
 *
 * This is a **derivation**, not a service: `tree()` is handed the roots, the sessions and the names
 * of any generated folders, and answers with nodes. Two properties make it the thing a check can
 * judge without a browser:
 *
 * - **One level at a time.** A node's `children` is the array of its direct children when the caller
 *   asked for that node, and `null` when it did not. `null` and `[]` mean different things — "not
 *   asked" and "asked and empty" — and the difference is what makes the tree lazy.
 * - **Folders only.** A file is not a node. A leaf is reached by opening the transcript, not by
 *   browsing, and the folders that a person does not mean by "content" (dot-directories,
 *   `node_modules`, `__pycache__`) are not enumerated at all.
 *
 * The classification is the conventions repository's own, restated here rather than read from it:
 * a type folder is a plural noun in underscores, an instance is kebab-case and sits directly inside
 * a type folder, and a type may repeat at any depth — including inside an instance. Nothing is read
 * from that repository, so heddle does not depend on one machine's layout; a registered-type
 * vocabulary is optional configuration elsewhere and is not needed to render.
 */

export type NodeKind = 'roots' | 'workspace' | 'type' | 'instance' | 'folder' | 'generated'

/** What a folder's session contributes to its row. */
export interface TreeSession {
  readonly id: string
  readonly turns: number
  readonly title?: string
}

export interface TreeNode {
  readonly path: string
  readonly kind: NodeKind
  readonly label: string
  /** The type's short name, for a type folder; `null` everywhere else. */
  readonly badge: string | null
  readonly session: TreeSession | null
  /** Direct children when they were asked for, `null` when they were not. */
  readonly children: readonly TreeNode[] | null
}

/** A registered root, as the workspace record states it. */
export interface TreeRoot {
  readonly path: string
  readonly title: string
}

export interface TreeInput {
  readonly roots: readonly TreeRoot[]
  /** Every session, in any order; the newest bound to a folder is that folder's session. */
  readonly sessions: readonly SessionMeta[]
  /** Folder names a tool writes, matched by name, as the conventions linter's `--generated` names one. */
  readonly generated?: readonly string[]
}

/** A plural noun wrapped in underscores. A single underscore is not enough. */
const TYPE_FOLDER = /^_[a-z0-9]+(_[a-z0-9]+)*_$/

/** Kebab-case, two to four lowercase words. */
const INSTANCE_NAME = /^[a-z0-9]+(-[a-z0-9]+){1,3}$/

/** Folders nothing means by "content", so the tree does not enumerate them. */
const PLUMBING = new Set(['node_modules', '__pycache__'])

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * A type's badge: its name with the vowels dropped, uppercased, three letters.
 *
 * The rule is not decoration. Two letters would collide on the three types that matter most here —
 * `_context_`, `_conventions_` and `_constitutions_` all begin `co` — and dropping the vowels gives
 * `CNT`, `CNV` and `CNS`, which do not. When fewer than three consonants remain the full name
 * supplies the rest, so `_web_` does not become a one-letter badge.
 */
export function badgeFor(name: string): string {
  const letters = name.replace(/_/g, '').toLowerCase()
  const consonants = letters.replace(/[aeiou]/g, '')
  const source = consonants.length >= 3 ? consonants : letters
  return source.slice(0, 3).toUpperCase()
}

/** What a folder is, given what its parent is. */
export function classify(name: string, parent: NodeKind, generated: ReadonlySet<string>): NodeKind {
  if (generated.has(name)) return 'generated'
  if (TYPE_FOLDER.test(name)) return 'type'
  if (parent === 'type' && INSTANCE_NAME.test(name)) return 'instance'
  return 'folder'
}

/** The newest session bound to each folder, so a folder row can be its session. */
function currentByFolder(sessions: readonly SessionMeta[]): Map<string, SessionMeta> {
  const map = new Map<string, SessionMeta>()
  for (const meta of sessions) {
    const canonical = canonicalPath(meta.cwd)
    const seen = map.get(canonical)
    if (seen === undefined || seen.created < meta.created) map.set(canonical, meta)
  }
  return map
}

/** The subdirectories worth showing, name-sorted the way a person reads a list. */
function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !PLUMBING.has(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => collator.compare(left, right))
  } catch {
    // A folder that cannot be read is a folder with nothing to show, not a failure of the tree.
    return []
  }
}

interface Context {
  readonly roots: readonly TreeRoot[]
  readonly byPath: Map<string, TreeRoot>
  readonly generated: ReadonlySet<string>
  readonly sessions: Map<string, SessionMeta>
  /** The nearest root strictly above a path, or `undefined` when there is none. */
  ownerOf(path: string): TreeRoot | undefined
}

function buildContext(input: TreeInput): Context {
  const roots = input.roots.map((root) => ({ path: canonicalPath(root.path), title: root.title }))
  const byPath = new Map(roots.map((root) => [root.path, root]))
  const ordered = [...roots].sort((left, right) => depthOf(right.path) - depthOf(left.path))
  return {
    roots,
    byPath,
    generated: new Set(input.generated ?? []),
    sessions: currentByFolder(input.sessions),
    ownerOf: (path) => ordered.find((root) => root.path !== path && isUnder(root.path, path)),
  }
}

function row(path: string, kind: NodeKind, label: string, context: Context): Omit<TreeNode, 'children'> {
  /**
   * A session is shown on an **instance**, and nowhere else.
   *
   * The owner's rule, stated 2026-10-11: the type folders are the boundaries, and a session node
   * exists only where the `_type_` plus `<instance>` pattern matches. So a workspace root, a plain
   * container (`shared/`, `src/`) and a type folder itself carry no session — and neither does a
   * folder nested inside an instance, which is the case a "the folder has a session, show it" rule
   * gets wrong: several levels of ordinary structure may sit between a boundary and the `_type_`
   * that follows it, and none of them is a place to work.
   *
   * A session bound to a folder that is not an instance is not lost. It is in the store, in
   * `heddle sessions`, and in its workspace's account; it simply is not a node of this tree, because
   * the tree is a view of the conventions' structure rather than a list of every conversation.
   */
  const meta = kind === 'instance' ? context.sessions.get(path) : undefined
  return {
    path,
    kind,
    label,
    badge: kind === 'type' ? badgeFor(label) : null,
    session:
      meta === undefined
        ? null
        : { id: meta.id, turns: meta.turns, ...(meta.title !== undefined ? { title: meta.title } : {}) },
  }
}

/** The direct children of a folder: its subfolders, or a registered root sitting among them. */
function childrenOf(dir: string, kind: NodeKind, context: Context): TreeNode[] {
  return subfolders(dir).map((name) => {
    const path = canonicalPath(join(dir, name))
    const root = context.byPath.get(path)
    if (root !== undefined) return { ...row(path, 'workspace', root.title, context), children: null }
    return { ...row(path, classify(name, kind, context.generated), name, context), children: null }
  })
}

/**
 * What a folder is, worked out from the root above it rather than from its name alone.
 *
 * The walk is why an instance is only an instance inside a type folder, and why a type may appear at
 * any depth: each segment is classified against the one before it.
 */
export function kindOf(path: string, input: TreeInput): NodeKind {
  const canonical = canonicalPath(path)
  const context = buildContext(input)
  const self = context.byPath.get(canonical)
  if (self !== undefined) return 'workspace'
  const owner = context.ownerOf(canonical)
  if (owner === undefined) return 'folder'
  const relative = canonical.slice(owner.path.length).split(sep).filter(Boolean)
  let kind: NodeKind = 'workspace'
  for (const segment of relative) kind = classify(segment, kind, context.generated)
  return kind
}

/**
 * One level of the tree: the roots when `path` is null, otherwise that folder and its children.
 *
 * A path outside every root is classified `folder` here; deciding that it is *refused* belongs to
 * the caller, which is the only layer that knows whether a refusal is an error (the CLI) or a `400`
 * (HTTP).
 */
export function tree(path: string | null, input: TreeInput): TreeNode {
  const context = buildContext(input)

  if (path === null || path === '') {
    const tops = context.roots.filter((root) => context.ownerOf(root.path) === undefined)
    return {
      path: '',
      kind: 'roots',
      label: 'workspaces',
      badge: null,
      session: null,
      children: tops.map((root) => ({ ...row(root.path, 'workspace', root.title, context), children: childrenOf(root.path, 'workspace', context) })),
    }
  }

  const canonical = canonicalPath(path)
  const root = context.byPath.get(canonical)
  const kind = root !== undefined ? 'workspace' : kindOf(canonical, input)
  const label = root !== undefined ? root.title : basename(canonical)
  return { ...row(canonical, kind, label, context), children: childrenOf(canonical, kind, context) }
}
