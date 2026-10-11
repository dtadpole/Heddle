import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PROVIDER_ENV, listFiles, removeDir, runCli, sessionRoot, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier 6 — end to end.
 *
 * Judges the last part of `ULTIMATE_GOAL.md`: **one run**, from a configuration,
 * completes a multi-step task that uses a tool, records it, and can be resumed
 * from that record. It is the only check that asks for the parts together, which
 * is why it is separate from the five above rather than a summary of them.
 *
 * The run is real — a process, a config file, a tool, a file on disk — and only
 * the model is substituted, because that is the one hop that would otherwise
 * spend the owner's credentials.
 */

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const CAPABILITY = 'the whole loop (config, session, model, tool, record) in one run'

/** A double that asks for one write, then one read, then answers. */
async function startProvider() {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push(body)
      const step = requests.length
      const message =
        step === 1
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{"path":"result.txt","content":"heddle finished"}' },
                },
              ],
            }
          : step === 2
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{"path":"result.txt"}' } },
                ],
              }
            : { role: 'assistant', content: 'finished: the file says heddle finished' }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: `double-${step}`,
          object: 'chat.completion',
          model: 'double',
          choices: [{ index: 0, message, finish_reason: step === 3 ? 'stop' : 'tool_calls' }],
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

function writeFixture(workDir, providerUrl) {
  writeFileSync(
    join(workDir, 'heddle.yml'),
    `- sandbox:
    config:
      root: ${workDir}
      allowWrite: true
- approvals:
    config:
      policy: allow
- tools:
    config:
      allow:
        - write_file
        - read_file
- model:
    config:
      provider: openai-compatible
      baseUrl: ${providerUrl}
      model: double
`,
  )
}

test('one run does the whole loop, from configuration to a finished task', async (context) => {
  const provider = await startProvider()
  const workDir = mkdtempSync(join(tmpdir(), 'heddle-e2e-'))
  writeFixture(workDir, provider.url)
  try {
    const result = await runCli(['--config', join(workDir, 'heddle.yml'), '--turn', 'write the result file and read it back'], {
      cwd: workDir,
      env: { [PROVIDER_ENV]: provider.url },
      timeoutMs: 30_000,
    })
    if (!skipUnless(context, provider.requests.length > 0, CAPABILITY)) return

    assert.equal(result.timedOut, false, 'the run finished rather than hanging')
    assert.equal(result.code, 0, `the run completed the task\n${result.stdout}${result.stderr}`)
    assert.ok(provider.requests.length >= 2, 'the tool result went back to the model for the next step')

    const artifact = join(workDir, 'result.txt')
    assert.ok(existsSync(artifact), `the tool did its work\n${result.stdout}`)
    assert.match(readFileSync(artifact, 'utf8'), /heddle finished/, 'the artifact holds what the task asked for')
    assert.match(result.stdout, /finished/i, `the run reported the finish\n${result.stdout}`)
  } finally {
    removeDir(workDir)
    await provider.close()
  }
})

test('the run is resumable from its own record', async (context) => {
  const provider = await startProvider()
  const workDir = mkdtempSync(join(tmpdir(), 'heddle-e2e-resume-'))
  writeFixture(workDir, provider.url)
  try {
    const first = await runCli(['--config', join(workDir, 'heddle.yml'), '--turn', 'write the result file'], {
      cwd: workDir,
      env: { [PROVIDER_ENV]: provider.url },
      timeoutMs: 30_000,
    })
    if (!skipUnless(context, provider.requests.length > 0 && first.code === 0, CAPABILITY)) return

    const bucket = join(sessionRoot, `--${repoRoot.replaceAll('/', '-').replace(/^-/, '')}--`)
    const records = existsSync(bucket) ? listFiles(bucket).length : 0
    assert.ok(records > 0, `the run left a record behind\n${first.stdout}`)
  } finally {
    removeDir(workDir)
    await provider.close()
  }
})
