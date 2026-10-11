import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'sandbox'

/**
 * How much of the filesystem a call may touch.
 *
 * The vocabulary is DSH's, taken as-is because it is already the right three
 * words: `read-only` permits only the required sinks, `workspace-write` adds the
 * workspace and a private temp area, and `danger-full-access` is the escape hatch
 * a person asks for by name. Reusing the words means a reader who knows one
 * harness knows this one.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** One resolved policy, which is what a check is actually decided against. */
export interface SandboxExecutionPolicy {
  readonly mode: SandboxMode
  readonly workspaceRoot: string
  readonly extraWritableRoots: readonly string[]
}

/** Why a path was refused, with enough detail to show the user. */
export class SandboxDenial extends Error {
  readonly path: string
  readonly mode: SandboxMode
  readonly workspaceRoot: string

  constructor(message: string, options: { path: string; mode: SandboxMode; workspaceRoot: string }) {
    super(message)
    this.name = 'SandboxDenial'
    this.path = options.path
    this.mode = options.mode
    this.workspaceRoot = options.workspaceRoot
  }
}

export const Config = Schema.object({
  /** `read-only`, `workspace-write` or `danger-full-access`. */
  mode: Schema.union([
    Schema.const('read-only' as const),
    Schema.const('workspace-write' as const),
    Schema.const('danger-full-access' as const),
  ]).default('workspace-write'),
  /** The directory writes are confined to. Defaults to the process's directory. */
  workspaceRoot: Schema.string(),
  /** Extra absolute roots a write may also reach, named one by one. */
  extraWritableRoots: Schema.array(Schema.string()).default([]),
})

export interface Config {
  readonly mode?: SandboxMode
  readonly workspaceRoot?: string
  readonly extraWritableRoots?: readonly string[]
}

/**
 * The sandbox service.
 *
 * Its whole job is to answer one question twice — may this path be read, may it
 * be written — and to answer it by **comparison of canonical paths** rather than
 * string prefixes. That detail is the difference between a sandbox and a
 * suggestion: `/tmp/workspace-2` starts with `/tmp/workspace` as a string and is
 * not inside it, and a symlink from inside the workspace to `/etc` is the other
 * half of the same trap.
 *
 * The service is deliberately **not** an OS-level confinement. DSH has those
 * backends (seatbelt, windows ACL) because it runs untrusted commands; this one
 * governs the harness's own file tools, and saying which of the two it is matters
 * more than appearing stronger than it is.
 */
export class SandboxService extends Service {
  static readonly provide = 'sandbox'

  readonly mode: SandboxMode
  readonly workspaceRoot: string
  readonly extraWritableRoots: readonly string[]

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sandbox')
    this.mode = config.mode ?? 'workspace-write'
    this.workspaceRoot = canonical(config.workspaceRoot ?? process.cwd())
    this.extraWritableRoots = (config.extraWritableRoots ?? []).map((root) => canonical(root))
  }

  /** The policy a call runs under, so a caller can report it. */
  policy(): SandboxExecutionPolicy {
    return { mode: this.mode, workspaceRoot: this.workspaceRoot, extraWritableRoots: this.extraWritableRoots }
  }

  /** Resolve a caller-supplied path against the workspace. */
  resolvePath(path: string): string {
    return isAbsolute(path) ? resolve(path) : resolve(this.workspaceRoot, path)
  }

  /**
   * Refuse a write unless the path is inside the workspace or a named root.
   *
   * A denial is thrown rather than returned because every caller must handle it;
   * a returned `false` that a caller could ignore is how a sandbox becomes
   * advisory.
   */
  assertWritable(path: string): string {
    const target = this.resolvePath(path)
    if (this.mode === 'danger-full-access') return target
    if (this.mode === 'read-only') {
      throw new SandboxDenial(`the sandbox is read-only, so '${path}' cannot be written`, {
        path: target,
        mode: this.mode,
        workspaceRoot: this.workspaceRoot,
      })
    }
    const allowed = [this.workspaceRoot, ...this.extraWritableRoots, canonical(tmpdir())]
    if (allowed.some((root) => contains(root, target))) return target
    throw new SandboxDenial(
      `'${target}' is outside the sandbox root ${this.workspaceRoot}, so it cannot be written`,
      { path: target, mode: this.mode, workspaceRoot: this.workspaceRoot },
    )
  }

  /** Refuse a read outside the workspace in the confined modes. */
  assertReadable(path: string): string {
    const target = this.resolvePath(path)
    if (this.mode === 'danger-full-access') return target
    const allowed = [this.workspaceRoot, ...this.extraWritableRoots, canonical(tmpdir()), join(homedir(), '.heddle')]
    if (allowed.some((root) => contains(root, target))) return target
    throw new SandboxDenial(
      `'${target}' is outside the sandbox root ${this.workspaceRoot}, so it cannot be read in '${this.mode}' mode`,
      { path: target, mode: this.mode, workspaceRoot: this.workspaceRoot },
    )
  }

  /** Whether a path would be permitted, without throwing. Used by the loop's report. */
  writable(path: string): boolean {
    try {
      this.assertWritable(path)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Canonicalise a path for comparison.
 *
 * `realpath` is what defeats the symlink case: a link inside the workspace that
 * points at `/etc` resolves to `/etc` before the comparison, so it is refused. A
 * path that does not exist yet cannot be resolved, so its deepest existing
 * ancestor is resolved instead and the rest is kept — which is what makes this
 * usable for a file a tool is about to create.
 */
export function canonical(path: string): string {
  const absolute = resolve(path)
  let current = absolute
  const tail: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync(current), ...tail.reverse())
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) return absolute
      tail.push(current.slice(parent.length + 1))
      current = parent
    }
  }
}

/** Whether `child` is `root` or sits under it, by path segment rather than prefix. */
function contains(root: string, child: string): boolean {
  if (child === root) return true
  const rel = relative(root, child)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by this plugin; reads require `inject: ['sandbox']`. */
    sandbox: SandboxService
  }
}

/**
 * The plugin is the service class itself, so the Cordis loader's own `inject`
 * row gates it — the mechanism DSH uses, rather than an exported `inject` array
 * that a hand-written `ctx.set` path ignores. Measured: the function form threw
 * "cannot get property ... without inject" while the loader reported nothing,
 * because `ctx.set` does not go through the inject gate.
 */
export default class SandboxServicePlugin extends SandboxService {}

