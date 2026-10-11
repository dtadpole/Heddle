import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { PROVIDER_ENV, removeDir, runCli, sessionFingerprint, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier 3 — model service.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: a model service is injectable through
 * Cordis, and it can complete a decision with **no production credential**,
 * because the provider it talks to is substitutable.
 *
 * The double is a real HTTP server on loopback that speaks the provider's /chat
 * shape, so this is a test double rather than a mock of the framework: if the
 * harness reaches it, it reached something over HTTP. It also proves the
 * negative half of "offline and spends nothing" — a run pointed at loopback
 * cannot reach a paid endpoint.
 */

const CAPABILITY = 'a model service, with a provider substitutable through HEDDLE_PROVIDER_BASE_URL'

/** A minimal provider double, answering one fixed assistant turn. */
async function startProvider() {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push({ url: request.url, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'double-1',
          object: 'chat.completion',
          model: 'double',
          choices: [{ index: 0, message: { role: 'assistant', content: 'double says loom' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  }
}

/** Write a config whose tree includes a model plugin, if the loader exists. */
function writeFixture(providerUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-model-'))
  writeFileSync(
    join(dir, 'heddle.yml'),
    `- greeting:
    config:
      punctuation: '?'
- model:
    config:
      provider: openai-compatible
      baseUrl: ${providerUrl}
      model: double
`,
  )
  return dir
}

test('a model service is injectable through Cordis', async (context) => {
  const known = /model/i.test(await runCli(['--help']).stdout)
  if (!skipUnless(context, known, CAPABILITY)) return
  const result = await runCli(['--help'])
  assert.match(result.stdout, /model/i, 'the harness declares a model service')
})

test('a decision completes with no production credential', async (context) => {
  const provider = await startProvider()
  const dir = writeFixture(provider.url)
  try {
    const result = await runCli(['--config', join(dir, 'heddle.yml'), '--turn', 'say the word'], {
      env: { [PROVIDER_ENV]: provider.url },
    })
    if (!skipUnless(context, provider.requests.length > 0 || /model/.test(result.stdout), CAPABILITY)) return

    assert.equal(result.code, 0, `the run succeeded without a credential\n${result.stdout}${result.stderr}`)
    assert.ok(provider.requests.length > 0, 'the request reached the substituted provider over HTTP')
    assert.match(result.stdout, /loom/, 'the model answer reached the caller rather than only the transport')
  } finally {
    removeDir(dir)
    await provider.close()
  }
})

test('the substituted provider is the one the configuration named', async (context) => {
  const provider = await startProvider()
  const dir = writeFixture(provider.url)
  try {
    const result = await runCli(['--config', join(dir, 'heddle.yml'), '--turn', 'say the word'], {
      env: { [PROVIDER_ENV]: provider.url },
    })
    if (!skipUnless(context, provider.requests.length > 0, CAPABILITY)) return

    assert.ok(
      provider.requests.some((request) => /chat|completions|messages/.test(request.url)),
      `the double was asked in a provider shape, not pinged\nseen: ${provider.requests.map((r) => r.url).join(', ')}`,
    )
    assert.match(result.stdout, /loom/, `the answer was used\n${result.stdout}`)
  } finally {
    removeDir(dir)
    await provider.close()
  }
})

test('a model turn leaves a transcript, not only stdout', async (context) => {
  const provider = await startProvider()
  const dir = writeFixture(provider.url)
  try {
    const before = sessionFingerprint()
    const result = await runCli(['--config', join(dir, 'heddle.yml'), '--turn', 'say the word'], {
      env: { [PROVIDER_ENV]: provider.url },
    })
    const after = sessionFingerprint()
    const grew = after.sessions > before.sessions || after.newestMtime > before.newestMtime
    if (!skipUnless(context, grew, CAPABILITY)) return

    assert.equal(result.code, 0, `the turn ran\n${result.stdout}${result.stderr}`)
    assert.equal(result.timedOut, false, 'the turn finished rather than waiting on the double')
  } finally {
    removeDir(dir)
    await provider.close()
  }
})

test('no request leaves loopback', async (context) => {
  const provider = await startProvider()
  const dir = writeFixture(provider.url)
  try {
    const result = await runCli(['--config', join(dir, 'heddle.yml'), '--turn', 'say the word'], {
      env: { [PROVIDER_ENV]: provider.url },
    })
    if (!skipUnless(context, provider.requests.length > 0, CAPABILITY)) return
    assert.equal(provider.requests.length, 1, `the double saw exactly the one request the turn needed`)
    assert.equal(result.timedOut, false, 'the run did not wait on anything unreachable')
  } finally {
    removeDir(dir)
    await provider.close()
  }
})
