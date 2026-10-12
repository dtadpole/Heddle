import { sep } from 'node:path'

/**
 * Where a session's log is filed: under the **workspace it belongs to**.
 *
 * The owner's ruling of 2026-10-11 — `~/.heddle/sessions/<workspace>/<session-id>.jsonl` — and the
 * reason it is a folder per workspace rather than one flat directory: a person who opens the store
 * wants to see whose logs they are, and a folder named after the folder the session ran in answers that
 * before anything is opened. The alternative, one directory per session, says nothing until you read a
 * metadata file inside it.
 *
 * The rule for turning a path into a folder name is **DSH's own**, restated here rather than reinvented:
 * separators become `-`, the result is wrapped in `--…--` so the name is bounded and obviously derived,
 * and a leading separator does not produce a leading dash. It is human-navigable and lossy on purpose —
 * two different paths can share a key, which is why the key is a *filing* decision and never an identity:
 * the session id is the identity, and the meta record carries the canonical `cwd` beside it.
 */

/** The folder a session with this working directory is filed under. */
export function workspaceKey(cwd: string): string {
  const readable = cwd
    .split(sep)
    .filter((part) => part.length > 0)
    .join('-')
    // Characters that mean something to a filesystem, and the separators of the other platform, which a
    // path on this machine may still contain when it came from somewhere else.
    .replace(/[^A-Za-z0-9._-]/g, '~')
    .slice(0, 120)
  return readable.length === 0 ? '--root--' : `--${readable}--`
}
