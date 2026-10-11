import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
  /**
   * The host's temp directory **when the policy admits it**, and `undefined` when it does not.
   *
   * It is **not** in the default policy. Measured: including it unconditionally meant
   * `workspace-write` permitted a write to any path under `/var/folders/...` — a mode described as
   * "the workspace and nothing else" that in fact allowed a large, shared, world-writable tree.
   *
   * Named `tempRootPath` rather than `tempRoot` because the configuration's own `tempRoot` is the
   * **boolean** that asks for it, and two different types under one name is how the admission
   * silently stopped working: measured, the resolved policy carried the boolean's position in the
   * schema and the temp root never resolved to a path.
   */
  readonly tempRootPath?: string
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
  /**
   * Admit the host's temp directory to the policy. Off by default, and `true` means the real one.
   *
   * A boolean rather than a path because the useful value is always "the system temp directory",
   * and naming it here keeps a profile from having to guess the platform's path.
   */
  tempRoot: Schema.boolean().default(false),
})

export interface Config {
  readonly mode?: SandboxMode
  readonly workspaceRoot?: string
  readonly extraWritableRoots?: readonly string[]
  readonly tempRoot?: boolean
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
  readonly tempRoot: string | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sandbox')
    this.mode = config.mode ?? 'workspace-write'
    this.workspaceRoot = canonical(config.workspaceRoot ?? process.cwd())
    this.extraWritableRoots = (config.extraWritableRoots ?? []).map((root) => canonical(root))
    this.tempRoot = config.tempRoot === true ? canonical(tmpdir()) : undefined
  }

  /** The policy a call runs under, so a caller can report it. */
  policy(): SandboxExecutionPolicy {
    return {
      mode: this.mode,
      workspaceRoot: this.workspaceRoot,
      extraWritableRoots: this.extraWritableRoots,
      ...(this.tempRoot !== undefined ? { tempRootPath: this.tempRoot } : {}),
    }
  }

  /**
   * Resolve a caller-supplied path against the workspace, **and canonicalise it**.
   *
   * Canonicalising here rather than at each comparison is the whole fix for a measured bug: the
   * workspace roots are canonical, so comparing a raw path against them made a policy that had
   * admitted the temp directory refuse a write to it, because `/var/folders/...` is a symlink to
   * `/private/var/folders/...` and only one side of the comparison had been resolved. A sandbox that
   * compares a resolved path with an unresolved one is a sandbox that says no for the wrong reason.
   */
  resolvePath(path: string): string {
    return canonical(isAbsolute(path) ? resolve(path) : resolve(this.workspaceRoot, path))
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
    const allowed = [this.workspaceRoot, ...this.extraWritableRoots, ...(this.tempRoot !== undefined ? [this.tempRoot] : [])]
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
    /**
     * Reading is wider than writing in one respect only: the harness's own configuration directory
     * is readable so a confined run can read the profile it was started from. Nothing else joins
     * the list, and the temp directory is not special-cased here either — a read of arbitrary
     * scratch data is not something a confined mode should quietly permit.
     */
    const allowed = [
      this.workspaceRoot,
      ...this.extraWritableRoots,
      ...(this.tempRoot !== undefined ? [this.tempRoot] : []),
      join(homedir(), '.heddle'),
    ]
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
  /**
   * Resolve the deepest ancestor that exists, then put the missing tail back.
   *
   * The tail is the whole point, and the first version of this got it wrong in a way that made a
   * **new** file look like it was outside the workspace: measured, `canonical` returned the path
   * unresolved whenever any parent was missing, so `/var/folders/.../scratch.txt` stayed
   * `/var/folders/...` instead of becoming `/private/var/folders/...`, and a write the policy had
   * admitted was refused. A tool's most common path is a file that does not exist yet, so this is the
   * common case rather than an edge one.
   *
   * `realpath` on the existing prefix is what defeats a symlink inside the workspace pointing out of
   * it; the tail needs no resolution because it does not exist.
   */
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.push(basename(current))
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
export default class SandboxServicePlugin extends SandboxService {
  /**
   * The schema has to be declared on the plugin, and its absence was invisible.
   *
   * Measured: without this, the loader accepted the row's config and passed it through unvalidated —
   * so `tempRoot: true` never arrived, `workspace-write` kept refusing the temp directory, and every
   * check of the mode passed because the mode itself was fine. A config schema that is exported but
   * not declared is a config that is silently ignored.
   */
  static readonly Config = Config
}

