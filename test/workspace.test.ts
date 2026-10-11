import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { canonicalPath } from '../src/paths.ts'
import type { SessionMeta } from '../src/session/store.ts'
import { WorkspaceService } from '../src/workspace/service.ts'

/**
 * A workspace record: how a root came to exist, and what unregistering one does to its sessions.
 *
 * Both are decisions rather than mechanics, so they are pinned here where they can be read. The
 * `origin` distinction is what lets the UI show a person's chosen folders apart from the folders
 * `bootstrap` adopted because a session ran in them; the removal rule exists because a removed root
 * that still holds sessions is re-registered by the next run, which would make the button a lie.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-workspace-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function service(): WorkspaceService {
  counter += 1
  return new WorkspaceService(new Context(), { file: join(scratch, `workspaces-${counter}.json`) })
}

/** A folder that exists, since registering one that does not is refused by the routes. */
function folder(name: string): string {
  const path = join(scratch, `folder-${counter}-${name}`)
  mkdirSync(path, { recursive: true })
  return path
}

/** One session, as the store records its metadata. */
function session(id: string, cwd: string): SessionMeta {
  return { id, created: new Date().toISOString(), cwd, turns: 1 }
}

test('a folder a person registers is added, and a folder an owner adopts is auto', () => {
  const workspaces = service()
  const chosen = folder('chosen')
  const adopted = folder('adopted')

  assert.equal(workspaces.add(chosen).record.origin, 'added')
  assert.equal(workspaces.ensureOwner(adopted).origin, 'auto', 'adoption is marked, not silent')
  assert.equal(workspaces.list().length, 2)
})

test('registering an adopted folder promotes it rather than duplicating it', () => {
  const workspaces = service()
  const path = folder('promote')
  const adopted = workspaces.ensureOwner(path)
  assert.equal(adopted.origin, 'auto')

  const { record, created } = workspaces.add(path)
  assert.equal(created, false, 'the folder was already known')
  assert.equal(record.id, adopted.id, 'the same record, not a second one for the same path')
  assert.equal(record.origin, 'added', 'and it is now a folder a person chose')
  assert.equal(workspaces.list().length, 1)
})

test('a root with no sessions is removed without complaint', () => {
  const workspaces = service()
  const path = folder('empty')
  const { record } = workspaces.add(path)

  const outcome = workspaces.remove(record.id, { all: [] })
  assert.equal(outcome.removed.id, record.id)
  assert.equal(outcome.ownedSessions, 0)
  assert.deepEqual(workspaces.list(), [])
})

test('a root with sessions and nothing above it is refused, because the next run would re-register it', () => {
  const workspaces = service()
  const path = folder('busy')
  const { record } = workspaces.add(path)
  const all = [session('session-1', join(path, 'sub'))]
  mkdirSync(join(path, 'sub'), { recursive: true })

  assert.throws(
    () => workspaces.remove(record.id, { all }),
    /still holds 1 session/,
    'and the refusal names the count and the reason',
  )
  assert.equal(workspaces.list().length, 1, 'nothing was removed')

  const forced = workspaces.remove(record.id, { all, force: true })
  assert.equal(forced.ownedSessions, 1, 'force removes it and reports what it left behind')
  assert.deepEqual(workspaces.list(), [])
})

test('a root with a parent above it is removed, and its sessions are adopted by the parent', () => {
  const workspaces = service()
  const root = folder('project')
  const inner = join(root, 'packages', 'app')
  mkdirSync(inner, { recursive: true })
  workspaces.add(root)
  const { record } = workspaces.add(inner)
  const all = [session('session-1', join(inner, 'src'))]
  mkdirSync(join(inner, 'src'), { recursive: true })

  const outcome = workspaces.remove(record.id, { all })
  assert.equal(outcome.ownedSessions, 1)
  assert.equal(outcome.adoptedBy, root.split('/').pop(), 'the ancestor takes them, which is durable')
  assert.equal(workspaces.owner(join(inner, 'src'))?.path, canonicalPath(root), 'and ownership resolves to it afterwards')
})

test('a record written before the field existed stays where it was being shown', () => {
  const file = join(scratch, 'legacy.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      workspaceIds: ['w1'],
      workspaces: {
        w1: { id: 'w1', path: '/tmp/legacy', title: 'legacy', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
      },
    }),
  )
  const workspaces = new WorkspaceService(new Context(), { file })
  assert.equal(workspaces.list()[0]?.origin, 'added', 'absent means added, so nothing leaves the tree unasked')
})
