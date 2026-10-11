import { Context, Service } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

import type { SessionMeta } from '../session/store.ts'

/**
 * Workspaces: a folder, and the record that says it is one.
 *
 * Modelled on DSH's `dsh-workspace`, and the three decisions worth copying are:
 *
 * - **A workspace is both a record and a folder.** The record carries
 *   `{ id, path, title, sessionIds, createdAt, updatedAt }`; the folder is the path.
 *   Neither alone is a workspace.
 * - **Association is an equality, not a prefix.** A session belongs to a workspace
 *   when its canonical working directory **equals** the record's path. A session started
 *   in a subdirectory is not a member of its parent — it is a different folder, and DSH
 *   gives it its own bucket and lets it become its own workspace. That is stricter than
 *   it first looks and it is right: a parent's sessions would otherwise silently
 *   include an unrelated project nested inside it.
 * - **Order lives in arrays, not in a field on the record.** The workspace list is one
 *   ordered array and each record's `sessionIds` is another, so ordering is a
 *   property of the collection rather than a number on each item, and attaching a
 *   session is a prepend rather than a rewrite of every neighbour.
 *
 * The one simplification: DSH stores this behind its storage/credentials machinery.
 * Here it is one JSON file, which is what a single-process harness needs and what
 * makes the record something a person can read.
 */

export interface WorkspaceRecord {
  readonly id: string
  /** Canonical absolute path; the folder, and the association key. */
  readonly path: string
  readonly title: string
  /** Session ids in the workspace's own order, newest first. */
  readonly sessionIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface WorkspaceStoreShape {
  readonly version: number
  /** Workspace ids in the collection's own order. */
  readonly workspaceIds: readonly string[]
  readonly workspaces: Record<string, WorkspaceRecord>
}

/** Where the record lives. One file, outside every repository. */
export function defaultWorkspaceFile(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HEDDLE_HOME ?? join(homedir(), '.heddle')
  return join(home, 'workspaces.json')
}

/** A canonical path: `realpath` when the directory exists, `resolve` when it does not. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export const Config = Schema.object({
  /** Where the workspace record is kept. */
  file: Schema.string().default(defaultWorkspaceFile()),
})

export interface Config {
  readonly file?: string
}

/**
 * The workspace service.
 *
 * `ensure` is idempotent per path and is what makes the model self-healing: a session
 * whose directory has no workspace gets one the moment it is asked about, so the
 * record is derived from what exists rather than maintained by hand.
 */
export class WorkspaceService extends Service {
  static readonly provide = 'workspace'

  readonly file: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspace')
    this.file = (config.file ?? defaultWorkspaceFile()).startsWith('~')
      ? join(homedir(), (config.file ?? '').slice(1))
      : (config.file ?? defaultWorkspaceFile())
  }

  /** The whole record, read from disk each time rather than cached. */
  read(): WorkspaceStoreShape {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as WorkspaceStoreShape
      return {
        version: parsed.version ?? 1,
        workspaceIds: parsed.workspaceIds ?? [],
        workspaces: parsed.workspaces ?? {},
      }
    } catch {
      return { version: 1, workspaceIds: [], workspaces: {} }
    }
  }

  private write(shape: WorkspaceStoreShape): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(shape, null, 2)}\n`)
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
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    shape.workspaces[record.id] = record
    // Newest first, which is how DSH orders its workspace list.
    this.write({ ...shape, workspaceIds: [record.id, ...shape.workspaceIds] })
    return record
  }

  /** One workspace by id or by path. */
  find(idOrPath: string): WorkspaceRecord | undefined {
    const shape = this.read()
    if (shape.workspaces[idOrPath] !== undefined) return shape.workspaces[idOrPath]
    const canonical = canonicalPath(idOrPath)
    return Object.values(shape.workspaces).find((record) => record.path === canonical)
  }

  /**
   * Attach a session to the workspace whose path equals its working directory.
   *
   * Returns the workspace it was attached to, or `undefined` when the session's
   * directory is not a workspace — which is the equality rule doing its job rather than
   * a failure.
   */
  attach(meta: SessionMeta): WorkspaceRecord | undefined {
    const canonical = canonicalPath(meta.cwd)
    const shape = this.read()
    const record = Object.values(shape.workspaces).find((entry) => entry.path === canonical)
    if (record === undefined) return undefined
    if (record.sessionIds.includes(meta.id)) return record

    const updated: WorkspaceRecord = {
      ...record,
      sessionIds: [meta.id, ...record.sessionIds],
      updatedAt: new Date().toISOString(),
    }
    shape.workspaces[record.id] = updated
    this.write(shape)
    return updated
  }

  /** The sessions a workspace holds, in its own order, looked up by id. */
  sessions(record: WorkspaceRecord, all: readonly SessionMeta[]): readonly SessionMeta[] {
    const byId = new Map(all.map((meta) => [meta.id, meta]))
    return record.sessionIds.map((id) => byId.get(id)).filter((meta): meta is SessionMeta => meta !== undefined)
  }

  /**
   * Group every session under the workspace its directory names.
   *
   * This is what makes the model self-healing: a session recorded before the workspace
   * existed, or by an older run, is adopted on the next look rather than being invisible
   * forever. DSH does the same at startup by grouping stored headers by canonical cwd.
   */
  bootstrap(all: readonly SessionMeta[]): { readonly workspaces: number; readonly attached: number; readonly orphans: number } {
    const shape = this.read()
    const byPath = new Map(Object.values(shape.workspaces).map((record) => [record.path, record]))
    let attached = 0
    let orphans = 0
    for (const meta of all) {
      const canonical = canonicalPath(meta.cwd)
      const record = byPath.get(canonical)
      if (record === undefined) {
        // A directory with no workspace becomes one; DSH creates it on demand the same way.
        const created = this.ensure(canonical)
        byPath.set(created.path, created)
      }
      const current = byPath.get(canonical)
      if (current === undefined) {
        orphans += 1
        continue
      }
      if (current.sessionIds.includes(meta.id)) continue
      const updated: WorkspaceRecord = {
        ...current,
        sessionIds: [...current.sessionIds, meta.id],
      }
      const fresh = this.read()
      fresh.workspaces[updated.id] = updated
      this.write(fresh)
      byPath.set(canonical, updated)
      attached += 1
    }
    return { workspaces: byPath.size, attached, orphans }
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
    if (existsSync(this.file)) return
    // First run: derive the record from the sessions that already exist.
    this.bootstrap(ctx.session.list())
  }
}
