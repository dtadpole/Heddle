import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDouble, fixtureDir, httpConfig, isolatedHome, removeDir, runCli, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier 9 — the Web UI.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: a **Web UI on localhost, on a documented default
 * port**, that carries the session and its **live stream**.
 *
 * The streaming claim is judged **here as well as in its own part**, and it is the same event
 * that both views read: the check opens the UI's stream endpoint, starts a turn whose double
 * holds its terminator open, and requires the main-content and reasoning deltas to arrive on
 * the stream **before** the run finishes. A UI that only showed a finished answer would pass a
 * page check and fail this one.
 *
 * The server is started on an **ephemeral** port (`--port 0`) so the check never collides with
 * a real instance; the documented default is asserted separately, from the help text and from
 * the constant the server exports, because that is where a person reads it.
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

/**
 * Start the server for one check and wait until its URL line appears.
 *
 * The working directory is the **repository root**, not a fixture, because that is where the
 * default profile lives: measured, running the server from a scratch directory booted an empty
 * tree, and the first request then failed with "Cannot read properties of undefined (reading
 * 'list')" — a message about nothing that named nothing, from a harness with no plugins.
 * Sessions are redirected to the fixture with `--session-root` instead, which is the supported
 * way to keep them out of the owner's store.
 */
async function startServer(label, options = {}) {
  const home = isolatedHome(`web-${label}`)
  const work = fixtureDir(`web-${label}`)
  const double = await chatDouble({
    content: 'live content',
    reasoning: 'live reasoning',
    holdOpenMs: options.holdOpenMs ?? 1200,
  })
  const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'double', '--session-root', join(home, 'sessions')],
    { env: { HOME: home, HEDDLE_CONFIG: config } },
  )
  return { home, work, double, config, ...child, close: async () => {
    child.kill()
    await double.close()
    removeDir(home)
    removeDir(work)
  } }
}

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { join } = await import('node:path')
      const { repoRoot } = await import('../../_tools_/check-helpers/lib.mjs')
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
          resolvePromise({ child, url: match[1], output: () => output, kill: () => child.kill('SIGKILL') })
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

/**
 * Read an SSE body, recording **when each line arrived**.
 *
 * The arrival times are the whole point of this helper: "the UI streamed live" is a claim about
 * the order two things happened in, and a single timestamp taken when the reader finally
 * stopped cannot express it. Measured: comparing the moment the reader finished against the
 * moment the turn finished produced a four-millisecond race that failed one run in two, while
 * the deltas had plainly arrived first.
 */
async function readStream(url, predicate, cookie, timeoutMs = 12_000) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const response = await fetch(url, { signal: controller.signal, ...(cookie ? { headers: { cookie } } : {}) })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  /** The offset from the read's start to the first line matching each pattern. */
  const at = new Map()
  const mark = (chunk) => {
    for (const pattern of ['live reasoning', 'live content', 'event: done']) {
      if (!at.has(pattern) && chunk.includes(pattern)) at.set(pattern, Date.now() - startedAt)
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      text += chunk
      mark(chunk)
      if (predicate(text)) break
    }
  } catch {
    // an abort is a timeout, and the caller decides what the partial text means
  }
  clearTimeout(timer)
  controller.abort()
  return { text, at }
}

/**
 * Turn the printed URL into a cookie the way a browser does.
 *
 * The token is presented once, at the root, and everything after that is the cookie. The
 * redirect is followed manually because the cookie is on the 303 itself, and there is nothing
 * at the destination this check needs.
 */
async function cookieFor(url) {
  const handshake = await fetch(url, { redirect: 'manual' })
  const cookie = handshake.headers.get('set-cookie')
  if (cookie === null) throw new Error(`the handshake set no cookie (status ${handshake.status})`)
  return cookie.split(';')[0]
}

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('the documented default port is 3082', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  /**
   * The default is a promise to a person, so it is asserted twice: as the number the server
   * module exports, and as the number the documentation names. A check that only read the
   * constant would pass while the docs said something else.
   */
  const { DEFAULT_PORT } = await import('../../dist/server/web.js')
  assert.equal(DEFAULT_PORT, 3082, 'the server exports the documented default')
  const readme = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8'))
  const goal = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../ULTIMATE_GOAL.md', import.meta.url), 'utf8'))
  const mentioned = readme.includes('3082') || goal.includes('3082')
  assert.ok(mentioned, 'the default port is written down where a person would look for it')
})

test('the server serves a page on loopback and refuses a non-loopback bind', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const server = await startServer('page')
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/, `the URL names loopback and carries a token\n${server.url}`)
    const page = await fetch(server.url)
    assert.equal(page.status, 200, 'the page answers')
    const html = await page.text()
    assert.match(html, /<title>heddle<\/title>/, 'it is the harness page')
    assert.match(html, /EventSource|\/api\/events/, 'the page opens the event stream')
    assert.match(html, /id="log"|id="sessions"/, 'and it has somewhere to put what arrives')
  } finally {
    await server.close()
  }
})

test('the API answers with the token and refuses without it', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const server = await startServer('api')
  try {
    const denied = await fetch(`http://127.0.0.1:${new URL(server.url).port}/api/sessions`)
    assert.equal(denied.status, 401, 'a request without the token is refused')

    /**
     * The token in the URL is a **handshake at the root only**, and that is the design rather
     * than a limitation: a token repeated on every API call would sit in server logs and
     * browser history for no gain. So the check does what a browser does — presents the token
     * at the root, takes the cookie it sets, and uses the cookie from then on.
     *
     * Measured the wrong way first: fetching `/api/sessions?token=...` answers 401, which
     * looked like a broken token check until the handshake shape was read back.
     */
    const handshake = await fetch(server.url, { redirect: 'manual' })
    assert.equal(handshake.status, 303, `the root exchanges the token for a cookie
${handshake.status}`)
    const cookie = handshake.headers.get('set-cookie')
    assert.ok(cookie, 'the handshake set a cookie')
    assert.match(cookie, /HttpOnly/, 'the cookie is not readable by script')
    assert.match(cookie, /SameSite=Strict/, 'and it is not sent cross-site')

    const allowed = await fetch(new URL('/api/sessions', server.url), { headers: { cookie: cookie.split(';')[0] } })
    assert.equal(allowed.status, 200, 'the cookie is accepted')
    const sessions = await allowed.json()
    assert.ok(Array.isArray(sessions), 'and the answer is the session list')
  } finally {
    await server.close()
  }
})

test('main content and reasoning reach the stream while the model is still writing', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const server = await startServer('stream', { holdOpenMs: 1500 })
  try {
    const started = Date.now()
    // Open the stream, then start a turn, and require both deltas to arrive **before the
    // turn's own response closes**. That comparison is the claim: the turn writes everything
    // when it ends, so a client that saw the deltas first saw them live.
    //
    // Measured, and worth keeping in mind for anyone reading a timing number here: an absolute
    // deadline against the double's `holdOpenMs` is not the test, because a small event can sit
    // in a socket buffer for tens of milliseconds and reading it depends on scheduling. The
    // ordering against the turn's completion is a property of the code; the wall clock is a
    // property of the machine.
    let turnDoneAt = 0
    const cookie = await cookieFor(server.url)
    const streamPromise = readStream(new URL('/api/events', server.url).href, (text) => text.includes('live reasoning') && text.includes('live content'), cookie)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300))

    const turn = await fetch(new URL('/api/turn', server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ prompt: 'say something' }),
    })
    // The turn finished when its body has been read, not when the headers arrived.
    assert.equal(turn.status, 200, 'the turn was accepted')
    // Read the turn's own body only if the stream disappoints, so a failure says whether the
    // turn errored rather than making the reader guess from an empty stream.
    const turnBody = await turn.text()
    turnDoneAt = Date.now() - started

    const { text: stream, at } = await streamPromise
    assert.match(stream, /event: session/, `the stream carried session events\n${stream.slice(0, 400)}`)
    assert.match(stream, /live reasoning/, `a reasoning delta reached the stream\nturn said: ${turnBody.split('\n').filter((line) => line.startsWith('event:') || line.includes('message')).join(' | ')}\nstream: ${stream.slice(0, 400)}`)
    assert.match(stream, /live content/, `a content delta reached the stream\n${stream.slice(0, 600)}`)
    assert.ok(turnDoneAt > 0, 'the turn finished')
    /**
     * The claim, stated as the two arrival times: each delta reached the client **before** the
     * turn's own response completed. The turn writes its whole body when it ends, so a client
     * that saw a delta first saw it live rather than at the end.
     */
    const reasoningAt = at.get('live reasoning')
    const contentAt = at.get('live content')
    assert.ok(
      reasoningAt !== undefined && reasoningAt < turnDoneAt,
      `the reasoning delta arrived at ${reasoningAt}ms and the turn finished at ${turnDoneAt}ms`,
    )
    assert.ok(
      contentAt !== undefined && contentAt < turnDoneAt,
      `the content delta arrived at ${contentAt}ms and the turn finished at ${turnDoneAt}ms`,
    )
  } finally {
    await server.close()
  }
})
