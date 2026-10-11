import { Context, Service } from '@deepseek-ai/cordis'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

import { canonicalPath, depthOf, isUnder } from '../paths.ts'
import type { SessionMeta } from '../session/store.ts'

/**
 * Workspaces: a **target folder**, and the record that says it is one.
 *
 * Modelled on DSH's `dsh-workspace` with one deliberate divergence, and the divergence is the
 * owner's decision of 2026-10-11 (stated in full in `SESSION_TREE.md`):
 *
 * - **A workspace is both a record and a folder.** The record carries
 *   `{ id, path, title, createdAt, updatedAt }`; the folder is the path. Neither alone is a
 *   workspace. The path is the *root* — the target folder — and a session bound to any folder at or
 *   below it is a member.
 * - **Association is containment, compared by path segment.** DSH's rule is equality: a session
 *   belongs to the workspace whose path equals its working directory, so a subdirectory becomes a
 *   workspace of its own. Heddle's is containment, because its navigation is a tree of *folders*
 *   rather than of workspaces, and every folder that held a conversation would otherwise become a
 *   registration. `/a/b-sibling` is still not inside `/a/b`: the comparison is by segment, never by
 *   string.
 * - **The nearest root owns a session.** Roots may nest — `~/reflection` and
 *   `~/reflection/_projects_/x` can both be registered — and the deepest one above a folder is the
 *   one that accounts for it. DSH resolves the same way for display (`owningParentFolder`).
 * - **Order lives in an array, not in a field on the record.** The workspace list is one ordered
 *   array, so a new root is a prepend rather than a rewrite of every neighbour.
 *
 * The simplification DSH does not make: the record stores **no session account**. A session's
 * `cwd` already says which folder it is bound to, and membership is the containment rule applied to
 * it, so `sessionIds` was a second statement of one fact — and, worse, a statement the folder tree
 * cannot be built from. It is derived on every read instead. A version-1 file that still carries
 * the field is read without it and written back without it.
 */

export interface WorkspaceRecord {
  readonly id: string
  /** Canonical absolute path of the target folder. The root, and the association key. */
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface WorkspaceStoreShape {
  readonly version: number
  /** Workspace ids in the collection's own order. */
  readonly workspaceIds: readonly string[]
  readonly workspaces: Record<string, WorkspaceRecord>
}

/** What `add` reports: the record, and whether this call is what created it. */
export interface WorkspaceAddition {
  readonly record: WorkspaceRecord
  readonly created: boolean
}

/** Where the record lives. One file, outside every repository. */
export function defaultWorkspaceFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HEDDLE_HOME ?? join(homedir(), '.heddle')
  return join(home, 'workspaces.json')
}

export const Config = Schema.object({
  /** Where the workspace record is kept. */
  file: Schema.string().default(defaultWorkspaceFile()),
  /**
   * Folder names a tool writes.
   *
   * The folder tree names these rather than pretending they are content, and the names come from
   * configuration because nothing on disk distinguishes generated from authored — the same reason
   * the conventions linter takes `--generated <path>`.
   */
  generated: Schema.array(Schema.string()).default([]),
})

export interface Config {
  readonly file?: string
  readonly generated?: readonly string[]
}

/**
 * The workspace service.
 *
 * Every read reconciles the record with the sessions that exist, which is what makes the model
 * self-healing: a session whose folder has no root above it gets one the moment it is looked at, so
 * the record is derived from what exists rather than maintained by hand.
 */
export class WorkspaceService extends Service {
  static readonly provide = 'workspace'

  readonly file: string
  /** Folder names the tree should call generated. */
  readonly generated: readonly string[]

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspace')
    this.file = (config.file ?? defaultWorkspaceFile()).startsWith('~')
      ? join(homedir(), (config.file ?? '').slice(1))
      : (config.file ?? defaultWorkspaceFile())
    this.generated = config.generated ?? []
  }

  /** The whole record, read from disk each time rather than cached. */
  read(): WorkspaceStoreShape {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as {
        version?: number
        workspaceIds?: string[]
        workspaces?: Record<string, Partial<WorkspaceRecord> & { sessionIds?: unknown }>
      }
      const workspaces: Record<string, WorkspaceRecord> = {}
      for (const [id, record] of Object.entries(parsed.workspaces ?? {})) {
        if (typeof record?.path !== 'string' || typeof record?.title !== 'string') continue
        /**
         * Rebuilt field by field rather than spread, so a version-1 file's `sessionIds` is dropped
         * on the way in as well as on the way out. A spread would carry it forward forever.
         */
        workspaces[id] = {
          id: typeof record.id === 'string' ? record.id : id,
          path: record.path,
          title: record.title,
          createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
          updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date(0).toISOString(),
        }
      }
      return { version: 2, workspaceIds: parsed.workspaceIds ?? [], workspaces }
    } catch {
      return { version: 2, workspaceIds: [], workspaces: {} }
    }
  }

  private write(shape: WorkspaceStoreShape): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify({ ...shape, version: 2 }, null, 2)}\n`)
  }

  /** Every workspace, in the collection's order. */
  list(): readonly WorkspaceRecord[] {
    const shape = this.read()
    return shape.workspaceIds.map((id) => shape.workspaces[id]).filter((record): record is WorkspaceRecord => record !== undefined)
  }

  /** One workspace by path, creating the record when it does not exist yet. */
  ensure(path: string, title?: string): WorkspaceRecord {
    const canonical = canonicalPath(path)
    const shape = this.read()
    const existing = Object.values(shape.workspaces).find((record) => record.path === canonical)
    if (existing !== undefined) return existing

    const now = new Date().toISOString()
    const record: WorkspaceRecord = {
      id: randomUUID(),
      path: canonical,
      title: title ?? canonical.split('/').filter(Boolean).pop() ?? canonical,
      createdAt: now,
      updatedAt: now,
    }
    shape.workspaces[record.id] = record
    // Newest first, which is how DSH orders its workspace list.
    this.write({ ...shape, workspaceIds: [record.id, ...shape.workspaceIds] })
    return record
  }

  /** Register a target folder, reporting whether this call is what created the record. */
  add(path: string, title?: string): WorkspaceAddition {
    const before = this.find(path)
    const record = this.ensure(path, title)
    return { record, created: before === undefined }
  }

  /** One workspace by id or by path. */
  find(idOrPath: string): WorkspaceRecord | undefined {
    const shape = this.read()
    if (shape.workspaces[idOrPath] !== undefined) return shape.workspaces[idOrPath]
    const canonical = canonicalPath(idOrPath)
    return Object.values(shape.workspaces).find((record) => record.path === canonical)
  }

  /**
   * The root that owns a folder: the **nearest** registered root at or above it.
   *
   * `undefined` when no root is above the folder, which is a fact rather than a failure — the caller
   * decides whether to register one (see {@link ensureOwner}).
   */
  owner(path: string, records: readonly WorkspaceRecord[] = this.list()): WorkspaceRecord | undefined {
    const canonical = canonicalPath(path)
    return [...records]
      .sort((left, right) => depthOf(right.path) - depthOf(left.path))
      .find((record) => isUnder(record.path, canonical))
  }

  /**
   * The sessions a root accounts for: those bound to a folder at or below it, minus the ones a
   * **nearer** root owns.
   *
   * Derived, never stored. `all` is newest first, as the store returns it, and the order is kept so
   * a listing reads newest-first within a workspace too.
   */
  sessions(record: WorkspaceRecord, all: readonly SessionMeta[]): readonly SessionMeta[] {
    const records = this.list()
    return all.filter((meta) => {
      const canonical = canonicalPath(meta.cwd)
      if (!isUnder(record.path, canonical)) return false
      return this.owner(canonical, records)?.id === record.id
    })
  }

  /**
   * The root that owns a folder, registering the folder itself when nothing above it does.
   *
   * This is what keeps "a session always has a workspace" true without a hand-maintained record: the
   * run that creates a session in an unregistered folder registers that folder as a root.
   */
  ensureOwner(path: string): WorkspaceRecord {
    const canonical = canonicalPath(path)
    return this.owner(canonical) ?? this.ensure(canonical)
  }

  /**
   * Group every session under the nearest root above it, creating a root where there is none.
   *
   * DSH does the same at startup by grouping stored headers by canonical cwd. Idempotent: a session
   * already accounted for creates nothing.
   */
  bootstrap(all: readonly SessionMeta[]): { readonly workspaces: number; readonly attached: number; readonly created: number } {
    let attached = 0
    let created = 0
    for (const meta of all) {
      const canonical = canonicalPath(meta.cwd)
      if (this.owner(canonical) === undefined) {
        this.ensure(canonical)
        created += 1
      }
      attached += 1
    }
    return { workspaces: this.list().length, attached, created }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin. */
    workspace: WorkspaceService
  }
}

/** The workspace plugin: it needs the session store to bootstrap from. */
export default class WorkspacePlugin extends WorkspaceService {
  static readonly Config = Config

  static readonly inject = ['session']

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, config)
    /**
     * The record is reconciled with the sessions that exist **on every load**, not only on the
     * first.
     *
     * Measured, and it is what "grouped under a folder" means for a real user: a session recorded by
     * a run that started before its workspace existed — or by another process, or before this
     * machine had a record at all — was invisible to `heddle workspaces` forever, because the
     * bootstrap only ran when the file was absent. Reconciling each time is idempotent, adopts what
     * is missing, and keeps the record derived from the store rather than maintained by hand.
     */
    this.bootstrap(ctx.session.list())
  }
}
