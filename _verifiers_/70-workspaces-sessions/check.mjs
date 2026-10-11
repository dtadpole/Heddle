import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, isolatedHome, parseJson, readTranscript, removeDir, repoRoot, runCli, scriptedConfig, sessionsUnder, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier 7 — workspaces and sessions.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: **workspaces are folders with records, and sessions live
 * under a folder**, the way DSH does it.
 *
 * The part is judged from a user's seat rather than from the store's shape. A person who has run
 * two turns in two directories asks three questions: *where did my conversation go, which folder
 * does it belong to, and can I get back to it?* The checks answer those, and they read the
 * transcript on disk as well, because a listing that disagrees with the files is worse than no
 * listing.
 *
 * The association rule being judged is DSH's, and it is the one that surprises people: a session
 * belongs to the workspace whose path **equals** its working directory. A session started in a
 * subdirectory is not a member of its parent.
 */

const CAPABILITY = 'workspaces as folders with records, and sessions grouped under them'

function harness(label) {
  const home = isolatedHome(label)
  const work = fixtureDir(`session-work-${label}`)
  const { config } = scriptedConfig({ home, steps: [{ text: 'a remembered answer' }] })
  return {
    home,
    work,
    config,
    env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    /**
     * The project's own profile is named explicitly, and the session store is pointed at the fixture.
     *
     * Measured: a command run with `cwd` set to a fixture directory booted an empty tree, because the
     * profile is found beside the run — so the fixture passed `--config` with the repository's profile
     * rather than relying on the working directory to supply one. `--session-root` is the supported
     * way to keep the owner's store out of it.
     */
    args: ['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(home, 'sessions')],
  }
}

async function supportsCommands() {
  const help = await runCli(['--help'])
  return /workspaces/.test(help.stdout) && /sessions/.test(help.stdout)
}

test('a run writes a session record that outlives it', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('writes')
  try {
    const result = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(result.timedOut, false, `the run finished\n${result.stdout}${result.stderr}`)
    assert.equal(result.code, 0, `the turn succeeded\n${result.stdout}${result.stderr}`)
    const sessions = sessionsUnder(join(h.home, 'sessions'))
    assert.equal(sessions.length, 1, `the run left exactly one record behind\nfound: ${sessions.join(', ')}`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the transcript is readable on disk and holds the turn', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('readable')
  try {
    const result = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(result.code, 0, `the turn succeeded\n${result.stdout}${result.stderr}`)
    const transcript = join(h.home, 'sessions', sessionsUnder(join(h.home, 'sessions'))[0] ?? '', 'session.jsonl')
    assert.ok(existsSync(transcript), `the transcript exists at ${transcript}`)

    const events = readTranscript(transcript)
    const kinds = [...new Set(events.map((event) => event.type))]
    for (const wanted of ['message', 'assistant/completed', 'turn/completed']) {
      assert.ok(kinds.includes(wanted), `the transcript records '${wanted}'\nsaw: ${kinds.join(', ')}`)
    }
    const recorded = events
      .filter((event) => event.type === 'message')
      .flatMap((event) => (event.message?.content ?? []).map((part) => part.text ?? ''))
    assert.ok(recorded.includes('remember the word loom'), `the user's words are in the record\nsaw: ${recorded.join(' | ')}`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a resumed session carries the earlier turns', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('resume')
  try {
    const first = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const id = sessionsUnder(join(h.home, 'sessions'))[0]
    assert.ok(id, 'the first run created a session')

    const second = await runCli([...h.args, '--turn', 'what did I ask you to remember', '--resume', id], { env: h.env })
    assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)

    const texts = readTranscript(join(h.home, 'sessions', id, 'session.jsonl'))
      .filter((event) => event.type === 'message')
      .flatMap((event) => (event.message?.content ?? []).map((part) => part.text ?? ''))
    assert.ok(texts.includes('remember the word loom'), 'the first turn is still in the resumed session')
    assert.ok(texts.includes('what did I ask you to remember'), 'the second turn was appended to it')
    assert.equal(sessionsUnder(join(h.home, 'sessions')).length, 1, 'resuming did not start a second session')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the record is appended to, never rewritten', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('append')
  try {
    await runCli([...h.args, '--turn', 'first'], { env: h.env })
    const id = sessionsUnder(join(h.home, 'sessions'))[0] ?? ''
    const transcript = join(h.home, 'sessions', id, 'session.jsonl')
    const before = readFileSync(transcript, 'utf8')
    await runCli([...h.args, '--turn', 'second', '--resume', id], { env: h.env })
    const after = readFileSync(transcript, 'utf8')
    assert.ok(after.startsWith(before), 'the earlier bytes are still the beginning of the file')
    assert.ok(after.length > before.length, 'the second turn was appended')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session is grouped under the workspace whose folder it ran in', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('grouped')
  try {
    const run = await runCli([...h.args, '--turn', 'say something'], { env: h.env, cwd: h.work })
    assert.equal(run.code, 0, `the turn ran\n${run.stdout}${run.stderr}`)

    const listing = await runCli(['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions'), 'workspaces', '--json'], { env: h.env, cwd: h.work })
    assert.equal(listing.code, 0, `the command ran\n${listing.stdout}${listing.stderr}`)
    const workspaces = parseJson(listing.stdout)
    assert.ok(Array.isArray(workspaces) && workspaces.length > 0, `a workspace exists\n${listing.stdout}`)

    /**
     * The workspace is found by its **path**, not by its title, because a title is a label a person
     * can change and the path is what the association is actually made of.
     */
    const mine = workspaces.find((workspace) => workspace.path === h.work)
    assert.ok(mine, `the workspace names the directory the turn ran in (${h.work})\nsaw: ${workspaces.map((w) => w.path).join(', ')}`)
    assert.ok((mine.sessions ?? []).length > 0, 'and it holds the session that ran there')
    assert.equal(mine.sessions[0], sessionsUnder(join(h.home, 'sessions'))[0], 'the id in the record is the id on disk')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session in a subdirectory is not a member of its parent workspace', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('subdir')
  const sub = join(h.work, 'nested')
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(sub, { recursive: true })
    const inParent = await runCli([...h.args, '--turn', 'from the parent'], { env: h.env, cwd: h.work })
    assert.equal(inParent.code, 0, `the parent turn ran\n${inParent.stdout}${inParent.stderr}`)
    const inChild = await runCli([...h.args, '--turn', 'from the child'], { env: h.env, cwd: sub })
    assert.equal(inChild.code, 0, `the child turn ran\n${inChild.stdout}${inChild.stderr}`)

    const listing = await runCli(['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions'), 'workspaces', '--json'], { env: h.env, cwd: h.work })
    const workspaces = parseJson(listing.stdout)
    const parent = workspaces.find((workspace) => workspace.path === h.work)
    const child = workspaces.find((workspace) => workspace.path === sub)
    assert.ok(parent && child, `the child directory became its own workspace\nsaw: ${workspaces.map((w) => w.path).join(', ')}`)
    assert.equal((parent.sessions ?? []).length, 1, 'the parent holds only its own session')
    assert.equal((child.sessions ?? []).length, 1, 'and the child holds only its own')
    assert.notEqual(parent.sessions[0], child.sessions[0], 'the two are different sessions')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('a session can be found again without knowing its id', async (context) => {
  if (!skipUnless(context, await supportsCommands(), CAPABILITY)) return
  const h = harness('find')
  try {
    await runCli([...h.args, '--turn', 'the first conversation'], { env: h.env, cwd: h.work })
    await runCli([...h.args, '--turn', 'the second conversation'], { env: h.env, cwd: h.work })

    /**
     * A person who has forgotten the id asks the harness. Both the flat list and the workspace
     * listing must name what exists, because a session that can only be reached by `ls` is a
     * session that is effectively lost.
     */
    const sessions = parseJson(
      (await runCli(['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions'), 'sessions', '--json'], { env: h.env, cwd: h.work })).stdout,
    )
    assert.ok(Array.isArray(sessions), 'the session list is machine-readable')
    assert.equal(sessions.length, 2, `both sessions are listed\n${JSON.stringify(sessions).slice(0, 300)}`)
    assert.ok(
      sessions.some((meta) => String(meta.title ?? '').includes('first conversation')),
      'a session carries the title it was started with, so a person recognises it',
    )
    assert.ok(
      sessions.every((meta) => typeof meta.created === 'string' && meta.created.length > 0),
      'and when it was created',
    )

    const workspaces = parseJson(
      (await runCli(['--config', join(repoRoot, 'cordis.yml'), '--session-root', join(h.home, 'sessions'), 'workspaces', '--json'], { env: h.env, cwd: h.work })).stdout,
    )
    const mine = workspaces.find((workspace) => workspace.path === h.work)
    assert.equal((mine?.sessions ?? []).length, 2, 'and the workspace holds both')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})
