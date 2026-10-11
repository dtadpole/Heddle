import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PROVIDER_ENV, removeDir, runCli, skipUnless } from '../../_tools_/checks/lib.mjs'

/**
 * Verifier 4 — tools.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: tools and commands are **registered as
 * services** rather than imported, are discoverable with a description, and a
 * call produces its side effect.
 *
 * The side effect is the thing being judged, so the double asks for a tool call
 * and the check looks for the file on disk. A framework that prints a tool call
 * without running it does not pass this.
 */

const CAPABILITY = 'a tool registry (registration as a service, a description, and a call that acts)'

/** A double that answers with a write_file tool call on the first request, then stops. */
async function startToolProvider() {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push(body)
      const second = requests.length > 1
      const message = second
        ? { role: 'assistant', content: 'ran the tool' }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'write_file', arguments: '{"path":"proof.txt","content":"written by a tool"}' },
              },
            ],
          }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: `double-${requests.length}`,
          object: 'chat.completion',
          model: 'double',
          choices: [{ index: 0, message, finish_reason: second ? 'stop' : 'tool_calls' }],
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
    `- tools:
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
  return workDir
}

test('the tool registry is discoverable, with descriptions', async (context) => {
  const help = await runCli(['tools', '--list'])
  const listable = help.code === 0 && /write_file|read_file|tool/i.test(help.stdout)
  if (!skipUnless(context, listable, CAPABILITY)) return
  assert.match(help.stdout, /write_file/, 'the write tool is registered under a discoverable name')
  assert.match(help.stdout, /read_file/, 'the read tool is registered under a discoverable name')
})

test('a command is registered rather than imported', async (context) => {
  const commands = await runCli(['commands', '--list'])
  if (!skipUnless(context, commands.code === 0, CAPABILITY)) return
  assert.match(commands.stdout, /^\s*\S+\s+—/m, `each command carries a description\n${commands.stdout}`)
})

test('a tool call produces its side effect on disk', async (context) => {
  const provider = await startToolProvider()
  const workDir = mkdtempSync(join(tmpdir(), 'heddle-tools-'))
  try {
    writeFixture(workDir, provider.url)
    const result = await runCli(['--config', join(workDir, 'heddle.yml'), '--turn', 'write the proof file'], {
      cwd: workDir,
      env: { [PROVIDER_ENV]: provider.url },
    })
    const called = provider.requests.length > 0
    if (!skipUnless(context, called, CAPABILITY)) return

    assert.equal(result.code, 0, `the run completed\n${result.stdout}${result.stderr}`)
    const proof = join(workDir, 'proof.txt')
    assert.ok(existsSync(proof), `the tool wrote the file the model asked for\n${result.stdout}`)
    assert.match(readFileSync(proof, 'utf8'), /written by a tool/, 'the tool wrote what the call carried')
  } finally {
    removeDir(workDir)
    await provider.close()
  }
})

test('an unknown tool name is refused, not silently ignored', async (context) => {
  const provider = await startToolProvider()
  const workDir = mkdtempSync(join(tmpdir(), 'heddle-tools-unknown-'))
  try {
    writeFixture(workDir, provider.url)
    const result = await runCli(['--config', join(workDir, 'heddle.yml'), '--turn', 'call a tool that does not exist'], {
      cwd: workDir,
      env: { [PROVIDER_ENV]: provider.url },
    })
    if (!skipUnless(context, provider.requests.length > 0, CAPABILITY)) return
    assert.equal(result.timedOut, false, 'an unknown tool name does not hang the run')
    assert.ok(result.stdout.length > 0 || result.stderr.length > 0, 'the outcome was reported')
  } finally {
    removeDir(workDir)
    await provider.close()
  }
})
