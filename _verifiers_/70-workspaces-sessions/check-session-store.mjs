import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { fixtureDir, isolatedHome, readTranscript, removeDir, runCli, scriptedConfig, sessionsUnder, skipUnless } from '../../_tools_/checks/lib.mjs'

/**
 * Verifier 2 — session.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: a session survives the process that
 * produced it, and a resumed session carries the earlier turns rather than
 * starting blank.
 *
 * Every check drives a real turn against the **scripted** endpoint, so nothing
 * here spends anything and the same input produces the same transcript. Sessions
 * land in the fixture's own home rather than the owner's store, which is what
 * makes a look at the store a fact about this run rather than about yesterday's.
 */

const CAPABILITY = 'the session store (a run writing a transcript, and a flag that resumes one)'

function harness(label) {
  const home = isolatedHome(label)
  const work = fixtureDir(label)
  const { config } = scriptedConfig({ home, steps: [{ text: 'a remembered answer' }] })
  const sessions = join(home, 'sessions')
  return {
    home,
    work,
    config,
    env: { HEDDLE_CONFIG: config, HOME: home },
    sessions,
    args: ['--session-root', sessions],
  }
}

async function supportsTurns() {
  const help = await runCli(['--help'])
  return /--turn/.test(help.stdout)
}

test('a run writes a session record that outlives it', async (context) => {
  if (!skipUnless(context, await supportsTurns(), CAPABILITY)) return
  const h = harness('session-writes')
  try {
    const result = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(result.timedOut, false, `the run finished\n${result.stdout}${result.stderr}`)
    assert.equal(result.code, 0, `the turn succeeded\n${result.stdout}${result.stderr}`)
    const sessions = sessionsUnder(h.sessions)
    assert.equal(sessions.length, 1, `the run left exactly one record behind\nfound: ${sessions.join(', ')}`)
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the transcript is readable on disk and holds the turn', async (context) => {
  if (!skipUnless(context, await supportsTurns(), CAPABILITY)) return
  const h = harness('session-readable')
  try {
    const result = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(result.code, 0, `the turn succeeded\n${result.stdout}${result.stderr}`)
    const transcript = join(h.sessions, sessionsUnder(h.sessions)[0] ?? '', 'session.jsonl')
    assert.ok(existsSync(transcript), `the transcript exists at ${transcript}`)

    const events = readTranscript(transcript)
    assert.ok(events.length > 0, 'the transcript is not empty')
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
  if (!skipUnless(context, await supportsTurns(), CAPABILITY)) return
  const h = harness('session-resume')
  try {
    const first = await runCli([...h.args, '--turn', 'remember the word loom'], { env: h.env })
    assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)
    const id = sessionsUnder(h.sessions)[0]
    assert.ok(id, 'the first run created a session')

    const second = await runCli([...h.args, '--turn', 'what did I ask you to remember', '--resume', id], { env: h.env })
    assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)

    const texts = readTranscript(join(h.sessions, id, 'session.jsonl'))
      .filter((event) => event.type === 'message')
      .flatMap((event) => (event.message?.content ?? []).map((part) => part.text ?? ''))
    assert.ok(texts.includes('remember the word loom'), 'the first turn is still in the resumed session')
    assert.ok(texts.includes('what did I ask you to remember'), 'the second turn was appended to it')
    assert.equal(sessionsUnder(h.sessions).length, 1, 'resuming did not start a second session')
  } finally {
    removeDir(h.home)
    removeDir(h.work)
  }
})

test('the record is appended to, never rewritten', async (context) => {
  if (!skipUnless(context, await supportsTurns(), CAPABILITY)) return
  const h = harness('session-append')
  try {
    await runCli([...h.args, '--turn', 'first'], { env: h.env })
    const id = sessionsUnder(h.sessions)[0] ?? ''
    const transcript = join(h.sessions, id, 'session.jsonl')
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
