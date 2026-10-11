import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { listFiles, repoRoot, runCli, sessionFingerprint, sessionRoot, skipUnless } from '../../_tools_/checks/lib.mjs'

/**
 * Verifier 2 — session.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: a session survives the process that
 * produced it, and a resumed session carries the earlier turns instead of
 * starting blank.
 *
 * Each check measures the store before and after its own run rather than asking
 * whether a store exists. That distinction cost this verifier a false failure on
 * its first baseline: a bucket already existed because the scaffold had been run
 * by hand, so "a bucket exists" passed while this run recorded nothing at all.
 * A fingerprint of the run's own effect cannot be satisfied by someone else's
 * earlier run.
 */

const CAPABILITY = 'the session store (a run writing a transcript, and a flag that resumes one)'

/** How this project's workspace bucket is named in the session store. */
function bucketName() {
  return `--${repoRoot.replaceAll('/', '-').replace(/^-/, '')}--`
}

/** Run the CLI and report whether the run itself grew the session store. */
function runAndFingerprint(args) {
  const before = sessionFingerprint()
  const result = await runCli(args, { cwd: repoRoot })
  const after = sessionFingerprint()
  return { result, grew: after.sessions > before.sessions || after.newestMtime > before.newestMtime }
}

test('a run writes a session record that outlives it', async (context) => {
  const { result, grew } = runAndFingerprint([])
  if (!skipUnless(context, grew, CAPABILITY)) return

  assert.ok(grew, 'the run left a record behind')
  assert.equal(result.code, 0, `the run that recorded itself also succeeded\n${result.stdout}${result.stderr}`)
})

test('the transcript is readable on disk', async (context) => {
  const { result, grew } = runAndFingerprint([])
  if (!skipUnless(context, grew, CAPABILITY)) return

  assert.equal(result.code, 0, `the run that recorded itself also succeeded\n${result.stdout}${result.stderr}`)
  const bucket = join(sessionRoot, bucketName())
  const files = listFiles(bucket).filter((name) => name.includes('session.'))
  assert.ok(files.length > 0, `a session record exists for this workspace\nfound: ${files.join(', ')}`)
})

test('a resumed session carries the earlier turns', async (context) => {
  const help = await runCli(['--help'])
  const supportsResume = /--resume/.test(help.stdout)
  if (!skipUnless(context, supportsResume, `${CAPABILITY} and a --resume flag`)) return

  const first = await runCli(['--turn', 'remember the word loom'])
  assert.equal(first.code, 0, `the first turn ran\n${first.stdout}${first.stderr}`)

  const sessionId = /session-[0-9a-f-]{36}/.exec(first.stdout)?.[0]
  assert.ok(sessionId, `the first turn reported its session id\n${first.stdout}`)

  const second = await runCli(['--resume', sessionId, '--turn', 'what word did I ask you to remember'])
  assert.equal(second.code, 0, `the resumed turn ran\n${second.stdout}${second.stderr}`)
  assert.match(
    second.stdout,
    /loom/,
    `the resumed turn saw the earlier turn rather than a blank session\n${second.stdout}`,
  )
})

test('the transcript of a resumed session is append-only across runs', async (context) => {
  const bucket = join(sessionRoot, bucketName())
  const { grew } = runAndFingerprint([])
  if (!skipUnless(context, grew, CAPABILITY)) return

  const before = existsSync(bucket) ? listFiles(bucket).length : 0
  await runCli(['--turn', 'one more turn'])
  const after = existsSync(bucket) ? listFiles(bucket).length : 0
  assert.ok(after >= before, 'resuming a session does not discard the record it resumed from')
})
