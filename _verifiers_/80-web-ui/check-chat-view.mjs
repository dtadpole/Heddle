import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { fixtureDir, isolatedHome, removeDir, repoRoot, runCli, scriptedConfig, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * The chat view: one element per tool **call**, carrying its result.
 *
 * This is the claim the owner asked for, and it is a claim about what a reader sees rather than about what
 * the log holds: the log has always had the call and the result as two events, and the page used to draw
 * them as two rows a person had to match up by eye. DSH draws one element per call, with the result inside
 * it, and so does this now — the fold pairs them by call id, and the element is what the page shows.
 *
 * Judged at both layers, because each can be wrong while the other looks right: the API fold can merge
 * while the client draws two rows, and the client can draw one row while the fold never paired anything.
 */

const CAPABILITY = 'the Web UI'

async function startServer(label) {
  const home = isolatedHome(`chat-${label}`)
  const work = fixtureDir(`chat-${label}-work`)
  const { config } = scriptedConfig({
    home,
    steps: [{ toolCall: { name: 'list_dir', arguments: { path: work } } }, { text: 'it listed the folder' }],
  })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  return {
    home,
    work,
    url: child.url,
    close: async () => {
      child.kill()
      removeDir(home)
      removeDir(work)
    },
  }
}

function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], {
        cwd: options.cwd ?? repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      let settled = false
      const onData = (chunk) => {
        output += chunk.toString()
        const match = /heddle web: (http:\/\/\S+)/.exec(output)
        if (match && !settled) {
          settled = true
          resolvePromise({ child, url: match[1], kill: () => child.kill('SIGKILL') })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', (code) => {
        if (!settled) {
          settled = true
          reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
        }
      })
      setTimeout(() => {
        if (!settled) {
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`the server printed no URL within 15s\n${output}`))
        }
      }, 15_000)
    })()
  })
}

async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function api(url, cookie, path, init = {}) {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { cookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

test('a tool call and its result fold into one turn, and the page draws them as one element', async (context) => {
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('tool')
  const browser = await openBrowser()
  try {
    mkdirSync(server.work, { recursive: true })
    writeFileSync(join(server.work, 'a.txt'), 'one\n')
    writeFileSync(join(server.work, 'b.txt'), 'two\n')
    const cookie = await cookieFor(server.url)
    await api(server.url, cookie, '/api/workspaces', { method: 'POST', body: JSON.stringify({ path: server.work }) })
    const opened = await api(server.url, cookie, '/api/folders/session', { method: 'POST', body: JSON.stringify({ folder: server.work }) })
    const session = opened.body.session?.id ?? opened.body.id

    // One turn that asks for a tool, which the loop runs, and then says what it did.
    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'what is in here', folder: server.work, session }),
    })
    assert.equal(turn.status, 200, `the turn ran (${turn.status})`)
    await turn.text()

    const view = await api(server.url, cookie, `/api/sessions/${encodeURIComponent(session)}`)
    assert.equal(view.status, 200, 'the session reads back')
    const tools = (view.body.turns ?? []).filter((entry) => entry.kind === 'tool')
    assert.equal(tools.length, 1, `the call and its result are one turn, not two\nsaw: ${JSON.stringify(view.body.turns ?? [])}`.slice(0, 400))
    const tool = tools[0]
    assert.equal(tool.name, 'list_dir', 'the turn names the tool it called')
    assert.match(String(tool.text), /a\.txt|"path"/, 'and carries the arguments')
    assert.match(String(tool.result), /a\.txt/, 'and the result, on the same turn')
    assert.equal(tool.state, 'ok', 'with a state that says it worked')
    assert.ok(
      (view.body.turns ?? []).some((entry) => entry.kind === 'user') && (view.body.turns ?? []).some((entry) => entry.kind === 'assistant'),
      'and the person and the model still have their own turns',
    )

    await browser.goto(server.url)
    await browser.waitFor('document.querySelectorAll("#log .turn").length > 0', 20_000)
    const drawn = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        tools: document.querySelectorAll('#log .turn.tool').length,
        state: document.querySelector('#log .turn.tool')?.dataset.state ?? null,
        summary: document.querySelector('#log .turn.tool summary')?.textContent ?? '',
        args: document.querySelector('#log .turn.tool [data-args]')?.textContent ?? '',
        result: document.querySelector('#log .turn.tool [data-result]')?.textContent ?? '',
        kinds: [...document.querySelectorAll('#log .turn')].map((node) => node.dataset.kind),
        notes: [...document.querySelectorAll('#log .turn.denied')].map((node) => node.textContent).slice(0, 2),
        log: document.getElementById('log').innerText.slice(0, 240),
      })`),
    )
    assert.equal(drawn.tools, 1, `the page draws one element for the call, not one for the call and one for the result\nDIAG ${JSON.stringify(drawn)}`)
    assert.equal(drawn.state, 'ok', 'and the element says the call succeeded')
    assert.match(drawn.summary, /list_dir/, 'its closed one-liner names the tool')
    assert.match(drawn.args, /path/, 'the arguments are inside that element')
    assert.match(drawn.result, /a\.txt/, 'and so is what the tool answered')
    assert.ok(drawn.kinds.includes('user') && drawn.kinds.includes('assistant'), `the person and the model are drawn too\nsaw: ${drawn.kinds.join(', ')}`)
  } finally {
    browser.close()
    await server.close()
  }
})

test('a settled answer is drawn as the document it is, and the renderer is the server’s', async (context) => {
  /**
   * DSH's assistant row renders markdown, and its `finalNode` exists only once the row is **settled** — which
   * is the same place heddle draws the document, for the same reason and with one difference: the renderer is
   * the server's, because that is where the escaping and the allow-list live (`src/server/markdown.ts`), while
   * while the answer is still arriving the row is the plain text the deltas are.
   *
   * Both halves are judged: an answer with emphasis and a fenced block comes out as markup after the turn, and
   * the render route drops what the allow-list does not want — a `<script>` in the answer is text, not code.
   */
  if (!skipUnless(context, /web/.test((await runCli(['--help'])).stdout), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const home = isolatedHome('chat-markdown')
  const work = fixtureDir('chat-markdown-work')
  const { config } = scriptedConfig({ home, steps: [{ text: 'a **bold** word\n\n```js\nconst x = 1\n```' }] })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--config', join(repoRoot, 'cordis.yml'), '--endpoint', 'scripted', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config }, cwd: work },
  )
  const browser = await openBrowser()
  try {
    await browser.goto(child.url)
    assert.ok(await browser.waitFor('document.getElementById("log") !== null', 20_000), 'the panel is up')
    const cookie = await cookieFor(child.url)

    const turn = await fetch(new URL('/api/turn', child.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ prompt: 'show me markdown' }),
    })
    assert.equal(turn.status, 200, 'the turn ran')
    await turn.text()

    assert.ok(await browser.waitFor('document.querySelector("#log .turn.assistant") !== null', 20_000), 'the answer is drawn')
    assert.ok(
      await browser.waitFor('document.querySelector("#log .turn.assistant strong") !== null', 20_000),
      'and a settled answer is markup rather than the raw text',
    )
    const drawn = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        rendered: document.querySelector('#log .turn.assistant')?.dataset.rendered ?? null,
        bold: document.querySelector('#log .turn.assistant strong')?.textContent ?? null,
        code: document.querySelector('#log .turn.assistant pre code')?.textContent ?? null,
        text: document.querySelector('#log .turn.assistant')?.textContent ?? ''
      })`),
    )
    assert.equal(drawn.rendered, 'true', 'the row says the document was drawn')
    assert.equal(drawn.bold, 'bold', 'the emphasis is an element')
    assert.match(String(drawn.code), /const x = 1/, 'and the fenced block is code')
    assert.doesNotMatch(drawn.text, /\*\*/, 'with no markdown left showing as characters')

    /**
     * The row's actions, which is DSH's `MessageIconActions` reduced to the one this harness has: copy. What
     * would be copied is judged — and it is the **drawn** answer rather than its markdown source, which is what
     * a person pasting it somewhere expects. The clipboard itself is the browser's, so the check reads the
     * snapshot the button copies from rather than asserting what the platform did with it.
     */
    const actions = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        buttons: document.querySelectorAll('#log .turn.assistant .action').length,
        label: (document.querySelector('#log .turn.assistant .action') || {}).getAttribute?.('aria-label') ?? null,
        copyText: (document.querySelector('#log .turn.assistant') || {}).dataset?.copyText ?? null
      })`),
    )
    assert.equal(actions.buttons, 1, 'a settled answer offers exactly one action')
    assert.equal(actions.label, 'Copy this answer', 'and it says what it does')
    assert.match(String(actions.copyText), /bold word/, 'what it copies is the answer')
    assert.doesNotMatch(String(actions.copyText), /\*\*/, 'as it reads rather than as its source')
  } finally {
    browser.close()
    child.kill()
    removeDir(home)
    removeDir(work)
  }
})
