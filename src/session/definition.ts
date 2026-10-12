import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalPath } from '../paths.ts'
import type { SessionHandle } from './store.ts'

/**
 * The **definition** of one session, written into the folder it belongs to.
 *
 * The owner's ruling of 2026-10-11 splits a session in two, and this module is the half that is content:
 *
 * - the **log** — every event, in order — is machine state and lives outside any repository;
 * - the **definition** — which log this is, the folder the session is bound to, and how it is run — is
 *   written under `<branch>/_sessions_/<name>/` and is meant to be committed.
 *
 * The name comes from the clock rather than from the first prompt, because a session is created before it
 * has one. It matches the conventions' instance pattern (two to four kebab-case words) so that the folder
 * passes the linter like any other instance, and it sorts chronologically, so the newest session of a
 * branch is also the last one a listing shows.
 */

/** The type folder a branch's sessions live in. The tree never draws it — it hoists what is inside. */
export const SESSIONS_FOLDER = '_sessions_'

/** The machine-readable half of a definition. */
export const DEFINITION_FILE = 'session.json'

/** What a definition says, as the harness reads it back. */
export interface SessionDefinition {
  /** The instance name, which is also the folder's name. */
  readonly name: string
  /** The `_sessions_/<name>` folder. */
  readonly dir: string
  /** The `session.json` inside it. */
  readonly file: string
  /** The log this definition references, as the store actually keeps it. */
  readonly log: string
}

/** The fields written to `session.json`. */
export interface SessionDefinitionFields {
  readonly id: string
  readonly log: string
  readonly cwd: string
  readonly createdAt: string
  readonly title?: string
  readonly endpoint?: string
  readonly model?: string
}

/**
 * A name for a new session: `session-<yyyymmdd>-<hhmm>`, and an ordinal when that minute is taken.
 *
 * Three words, so it is a valid instance name; chronological, so a name-ordering is a time-ordering; and
 * stable, because a session that has been committed should not be renamed by the next one.
 */
export function sessionName(now: Date, taken: readonly string[] = []): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const base = `session-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  if (!taken.includes(base)) return base
  for (let ordinal = 2; ordinal < 100; ordinal += 1) {
    const candidate = `${base}-${ordinal}`
    if (!taken.includes(candidate)) return candidate
  }
  throw new Error(`could not name a session for ${base}: a hundred already exist for that minute`)
}

/** The entry point every content folder carries, for the definition folder. */
function indexFor(name: string, branch: string, definition: SessionDefinitionFields): string {
  return `---
title: ${name}
version: 1.0.0
description: One agentic session — the log it references, and how it is run.
grounded_in:
  - source: heddle session ${definition.id}
---

# \`${name}\`

One session of \`${branch}\`, created by heddle. The transcript is machine state and lives outside every
repository, at \`${definition.log}\`; this folder is the **definition** a person can read, review and
commit — which log the session is, and how it is run.

## What belongs in it

- [\`${DEFINITION_FILE}\`](${DEFINITION_FILE}) — the fields the harness reads: the log's path, the folder
  the session is bound to, and the endpoint and model it was started with.
`
}

/**
 * Write a session's definition under a branch, and answer with where it went.
 *
 * `taken` is the list of names already in the branch's `_sessions_` folder, so two sessions created in one
 * minute do not collide. The log is never touched: this writes the two small files and nothing else, which
 * is what keeps the definition safe to commit while the log is not.
 */
export function writeSessionDefinition(
  handle: SessionHandle,
  branch: string,
  options: { readonly createdAt: string; readonly title?: string; readonly endpoint?: string; readonly model?: string; readonly taken?: readonly string[] } ,
): SessionDefinition {
  const canonical = canonicalPath(branch)
  const name = sessionName(new Date(options.createdAt), options.taken ?? [])
  const dir = join(canonical, SESSIONS_FOLDER, name)
  mkdirSync(dir, { recursive: true })

  const fields: SessionDefinitionFields = {
    id: handle.id,
    log: handle.transcript,
    cwd: canonical,
    createdAt: options.createdAt,
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
  }
  writeFileSync(join(dir, DEFINITION_FILE), `${JSON.stringify(fields, null, 2)}\n`)
  writeFileSync(join(dir, 'INDEX.md'), indexFor(name, canonical, fields))
  return { name, dir, file: join(dir, DEFINITION_FILE), log: handle.transcript }
}

/** The session names a branch already holds, so a new one does not take an existing folder's name. */
export function existingSessionNames(branch: string): string[] {
  try {
    return readdirSync(join(canonicalPath(branch), SESSIONS_FOLDER), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
