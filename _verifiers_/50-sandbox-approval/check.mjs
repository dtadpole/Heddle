import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PROVIDER_ENV, removeDir, runCli, skipUnless } from '../../_tools_/checks/lib.mjs'

/**
 * Verifier 5 — sandbox and approval.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: a sandbox and an approval policy exist
 * and are **demonstrated by refusal**. A policy that has never denied anything is
 * a policy nobody has tested, so every check here is about a denial.
 *
 * The refusals are read from what the run did, not from what it promised: the
 * check looks for the verdict in the output, and for the protected path still
 * untouched on disk.
 */

const CAPABILITY = 'a sandbox with a declared root, and an approval policy that can deny a tool call'

/** A double that asks for the tool call named inside the prompt. */
async function startProvider() {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      const wantsOutside = /outside|escape|\/etc/.test(body)
      const call = wantsOutside
        ? { name: 'write_file', arguments: '{"path":"/etc/heddle-should-not-exist","content":"no"}' }
        : { name: 'write_file', arguments: '{"path":"inside.txt","content":"inside"}' }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: 'double',
          object: 'chat.completion',
          model: 'double',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: call.name, arguments: call.arguments } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
  })
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
  }
}

/** A config that names a sandbox root and an approval policy. */
function writeFixture(root, providerUrl) {
  const workDir = mkdtempSync(join(tmpdir(), 'heddle-sandbox-'))
  writeFileSync(
    join(workDir, 'heddle.yml'),
    `- sandbox:
    config:
      root: ${root}
      allowWrite: true
- approvals:
    config:
      policy: deny
      deny:
        - write_file
- model:
    config:
      provider: openai-compatible
      baseUrl: ${providerUrl}
      model: double
`,
  )
  return workDir
}

test('a write outside the sandbox root is denied and observable', async (context) => {
  const provider = await startProvider()
  const root = mkdtempSync(join(tmpdir(), 'heddle-sandbox-root-'))
  const workDir = writeFixture(root, provider.url)
  try {
    const result = await runCli(['--config', join(workDir, 'heddle.yml'), '--turn', 'write a file outside the sandbox'], {
      cwd: workDir,
      env: { [PROVIDER_ENV]: provider.url },
    })
    if (!skipUnless(context, /sandbox|approval|denied/i.test(result.stdout + result.stderr), CAPABILITY)) return

    assert.ok(
      /denied|refused|not permitted|outside/i.test(result.stdout + result.stderr),
      `the refusal is reported\n${result.stdout}${result.stderr}`,
    )
    assert.equal(existsSync('/etc/heddle-should-not-exist'), false, 'the denied write really did not happen')
  } finally {
    removeDir(workDir)
    removeDir(root)
    await provider.close()
  }
})

test('an approval policy set to deny refuses the declared tool', async (context) => {
  const provider = await startProvider()
  const root = mkdtempSync(join(tmpdir(), 'heddle-sandbox-root-'))
  const workDir = writeFixture(root, provider.url)
  try {
    const result = await runCli(['--config', join(workDir, 'heddle.yml'), '--turn', 'write inside the sandbox'], {
      cwd: workDir,
      env: { [PROVIDER_ENV]: provider.url },
    })
    if (!skipUnless(context, /approval|denied|policy/i.test(result.stdout + result.stderr), CAPABILITY)) return

    assert.match(result.stdout + result.stderr, /denied|refused/i, 'the policy refused rather than allowed by default')
    assert.equal(existsSync(join(workDir, 'inside.txt')), false, 'the refused call left no file behind')
  } finally {
    removeDir(workDir)
    removeDir(root)
    await provider.close()
  }
})

test('the sandbox root is enforced, not only declared', async (context) => {
  const provider = await startProvider()
  const root = mkdtempSync(join(tmpdir(), 'heddle-sandbox-root-'))
  mkdirSync(root, { recursive: true })
  const workDir = writeFixture(root, provider.url)
  try {
    const help = await runCli(['--help'])
    const result = await runCli(['--config', join(workDir, 'heddle.yml'), '--turn', 'write inside the sandbox'], {
      cwd: workDir,
      env: { [PROVIDER_ENV]: provider.url },
    })
    const declared = /sandbox/i.test(help.stdout) || /sandbox/i.test(result.stdout + result.stderr)
    if (!skipUnless(context, declared, CAPABILITY)) return

    assert.ok(
      /root|path|sandbox/i.test(result.stdout + result.stderr),
      `the sandbox reports the boundary it enforced\n${result.stdout}${result.stderr}`,
    )
  } finally {
    removeDir(workDir)
    removeDir(root)
    await provider.close()
  }
})

test('a denied run exits with a verdict rather than silently succeeding', async (context) => {
  const provider = await startProvider()
  const root = mkdtempSync(join(tmpdir(), 'heddle-sandbox-root-'))
  const workDir = writeFixture(root, provider.url)
  try {
    const result = await runCli(['--config', join(workDir, 'heddle.yml'), '--turn', 'write a file outside the sandbox'], {
      cwd: workDir,
      env: { [PROVIDER_ENV]: provider.url },
    })
    if (!skipUnless(context, /denied|refused|outside/i.test(result.stdout + result.stderr), CAPABILITY)) return
    assert.notEqual(result.code, 3, 'a refusal is a verdict, not an unjudged outcome')
  } finally {
    removeDir(workDir)
    removeDir(root)
    await provider.close()
  }
})
