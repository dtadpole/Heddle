import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { isFramed, LEGACY_TRANSCRIPT_NAME, SessionStore, TRANSCRIPT_NAME, transcriptIn } from '../src/session/store.ts'
import { decodeTranscript, isCompressed } from '../src/session/transcript.ts'

/**
 * What a session's record is on disk, and what a process keeps in memory about it.
 *
 * Two claims live here, both about the store rather than about any mechanism above it: a transcript
 * is a sequence of appended zstd frames — so an earlier byte is never rewritten and a torn tail
 * costs the last frame — and a process that has opened a session reads it from memory rather than
 * from the file on every call. The second is asserted the only way it can be honestly asserted: by
 * deleting the file and showing the store still answers.
 */

const scratch = mkdtempSync(join(tmpdir(), 'heddle-store-format-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

let counter = 0
function store(): { store: SessionStore; root: string } {
  counter += 1
  const root = join(scratch, `store-${counter}`)
  return { store: new SessionStore(root), root }
}

test('a new session writes versioned frames, and reads them back', () => {
  const { store: sessions } = store()
  const handle = sessions.create({ cwd: scratch })
  sessions.message(handle, { role: 'user', content: [{ type: 'text', text: 'hello' }] })

  /**
   * The **suffix** rather than the legacy full name: since 2026-10-11 a log is `<session-id>.v2.jsonl.zstd`
   * inside its workspace folder, so a test for `session.v2.jsonl.zstd` would fail on a file that is exactly
   * the format it means to check. What the claim is about is the version marker and the framing.
   */
  assert.ok(handle.transcript.endsWith('.v2.jsonl.zstd'), `a new session uses the versioned name (${handle.transcript})`)
  assert.ok(isFramed(handle.transcript), 'and the store knows it is a framed log by its suffix')
  const bytes = readFileSync(handle.transcript)
  assert.ok(isCompressed(bytes), 'the file is a sequence of zstd frames')
  const decoded = decodeTranscript(bytes)
  assert.equal(decoded.format, 'zstd-frames')
  assert.equal(decoded.frames, 2, 'session/created and the message are two frames')
  assert.deepEqual(decoded.lines.map((line) => JSON.parse(line).type), ['session/created', 'message'])
})

test('appending never rewrites the bytes before it', () => {
  const { store: sessions } = store()
  const handle = sessions.create({ cwd: scratch })
  sessions.message(handle, { role: 'user', content: [{ type: 'text', text: 'one' }] })
  const before = readFileSync(handle.transcript)

  sessions.message(handle, { role: 'assistant', content: [{ type: 'text', text: 'two' }] })
  const after = readFileSync(handle.transcript)

  assert.ok(after.length > before.length, 'the second event was appended')
  assert.ok(after.subarray(0, before.length).equals(before), 'and every earlier byte is untouched')
})

test('a torn last frame costs that frame and nothing else', () => {
  const { store: sessions } = store()
  const handle = sessions.create({ cwd: scratch })
  for (const text of ['one', 'two', 'three']) {
    sessions.message(handle, { role: 'user', content: [{ type: 'text', text }] })
  }
  const bytes = readFileSync(handle.transcript)
  const torn = bytes.subarray(0, bytes.length - 4)
  const decoded = decodeTranscript(torn)
  assert.equal(decoded.torn, true, 'the read says the record stopped early')
  assert.deepEqual(
    decoded.lines.map((line) => JSON.parse(line).type),
    ['session/created', 'message', 'message'],
    'the three complete frames still read',
  )
})

test('a session opened once answers from memory, not from the file', () => {
  const { store: sessions } = store()
  const handle = sessions.create({ cwd: scratch })
  sessions.message(handle, { role: 'user', content: [{ type: 'text', text: 'kept' }] })

  // First touch loads from disk; everything after is served from the fold.
  assert.equal(sessions.count(handle), 2)
  rmSync(handle.transcript)

  assert.equal(sessions.count(handle), 2, 'the count still answers after the file is gone')
  assert.equal(sessions.read(handle).length, 2, 'so does the read')
  assert.equal(sessions.surface(handle).nodes.length, 1, 'and the surface folded from it — one node, since session/created takes no position')
  assert.equal(sessions.deriveMessages(handle).length, 1, 'and the messages derived from it')
})

test('a transcript written before this format is still read, and still appended to as plain text', () => {
  const { store: writer, root } = store()
  const created = writer.create({ cwd: scratch })
  const dir = created.dir
  rmSync(created.transcript)

  // A v1 transcript on disk, opened by a later process: a second store, so nothing is cached.
  const legacy = join(dir, LEGACY_TRANSCRIPT_NAME)
  writeFileSync(legacy, `${JSON.stringify({ seq: 0, at: new Date().toISOString(), type: 'session/created', cwd: scratch })}\n`)
  const sessions = new SessionStore(root)

  const opened = sessions.open(created.id)
  assert.ok(opened !== null)
  assert.equal(opened.transcript, legacy, 'the session keeps the format it was born with')
  assert.equal(sessions.count(opened), 1)

  sessions.message(opened, { role: 'user', content: [{ type: 'text', text: 'plain' }] })
  const text = readFileSync(legacy, 'utf8')
  assert.ok(text.endsWith('\n'), 'the legacy file is still plain text')
  assert.deepEqual(
    text.trim().split('\n').map((line) => JSON.parse(line).type),
    ['session/created', 'message'],
    'readable with cat, as it was',
  )
  assert.equal(transcriptIn(dir), legacy, 'and asking the directory still finds the plain file')
})

test('a torn tail is cut off, so the next event is still readable', () => {
  /**
   * The failure this prevents was measured: appending past a torn frame wrote an event that nothing
   * could ever read, because the walk stops at the first incomplete frame. A session interrupted once
   * became a session that silently swallowed everything after the interruption.
   */
  const { store: writer, root } = store()
  const created = writer.create({ cwd: scratch })
  writer.message(created, { role: 'user', content: [{ type: 'text', text: 'before the crash' }] })
  const whole = readFileSync(created.transcript)
  rmSync(created.transcript)
  // A frame written halfway: the bytes of the previous event, plus part of the next one.
  appendFileSync(created.transcript, whole)
  const next = (async () => {
    const { encodeFrame } = await import('../src/session/transcript.ts')
    return encodeFrame(`${JSON.stringify({ seq: 99, at: new Date().toISOString(), type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'half' }] } })}\n`)
  })()
  return next.then((frame) => {
    const torn = Buffer.concat([whole, frame.subarray(0, Math.floor(frame.length / 2))])
    writeFileSync(created.transcript, torn)

    const sessions = new SessionStore(root)
    const opened = sessions.open(created.id)
    assert.ok(opened !== null)
    sessions.message(opened, { role: 'user', content: [{ type: 'text', text: 'after the crash' }] })

    const repaired = readFileSync(opened.transcript)
    assert.ok(!decodeTranscript(repaired).torn, 'the file no longer ends in a half-written frame')
    const recovered = decodeTranscript(repaired)
    const texts = recovered.lines
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'message')
      .map((event) => event.message.content[0].text)
    assert.deepEqual(texts, ['before the crash', 'after the crash'], 'both events read, and the torn one is gone')
    assert.ok(
      recovered.lines.some((line) => JSON.parse(line).type === 'transcript/repaired'),
      'and the repair is recorded on the session rather than done silently',
    )
  })
})

test('a transcript that is missing entirely is recreated by the next append', () => {
  const { store: sessions, root } = store()
  const handle = sessions.create({ cwd: scratch })
  rmSync(handle.transcript)

  const fresh = new SessionStore(root)
  const opened = fresh.open(handle.id)
  assert.ok(opened !== null, 'the session is still openable: its metadata is what makes it a session')
  fresh.message(opened, { role: 'user', content: [{ type: 'text', text: 'the first event that survives' }] })
  assert.deepEqual(
    decodeTranscript(readFileSync(opened.transcript)).lines.map((line) => JSON.parse(line).type),
    ['message'],
    'the appended event is on disk and readable',
  )
})
