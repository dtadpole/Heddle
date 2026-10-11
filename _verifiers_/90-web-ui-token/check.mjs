import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDouble, fixtureDir, httpConfig, isolatedHome, removeDir, runCli, skipUnless } from '../../_tools_/check-helpers/lib.mjs'
import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'

/**
 * Verifier 10 — the Web UI's token.
 *
 * Judges one part of `ULTIMATE_GOAL.md`: the page **and its event stream** are protected by a
 * token, the way DSH's Web UI protects itself.
 *
 * DSH's shape is the one being judged, so it is worth naming what each check corresponds to:
 * a per-process launch token printed in the URL and compared in constant time; a root exchange
 * that turns that token into an `HttpOnly`, `SameSite=Strict` cookie bound to the authority; a
 * `401` for anything without one; and a Host/Origin fence that runs **before** any secret is
 * compared. The stream is checked separately from the API because a token that protects the API
 * and not the stream protects the data that matters least.
 *
 * The cookie is handled by hand rather than by a cookie jar, because the point is what the
 * server sets: `HttpOnly` and `SameSite` are the assertions, and a jar would hide them.
 */

const CAPABILITY = 'a token that protects the Web UI and its event stream'

/**
 * Exchange a server's launch URL for the cookie heddle issues, the way a browser's first visit does.
 *
 * The launch token becomes a signed HttpOnly cookie on a 303; every later request carries the cookie and
 * no token. A check that wants to act like an authenticated caller needs this and not the token.
 */
async function handshakeCookie(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const set = response.headers.get('set-cookie')
  if (set === null) throw new Error(`no cookie from ${url} (HTTP ${response.status})`)
  return set.split(';')[0]
}

async function startServer(label) {
  const home = isolatedHome(`token-${label}`)
  const work = fixtureDir(`token-${label}`)
  const double = await chatDouble({ content: 'live content', reasoning: 'live reasoning' })
  const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
  return {
    home,
    work,
    double,
    config,
    /**
     * `HEDDLE_HOME` is set as well as `HOME`, because that is what the server reads for both the
     * session store and the cookie-signing secret. Measured: with `HOME` alone the secret was written
     * to the real `~/.heddle`, so a check about the secret's file mode could not find it and a check
     * about two processes sharing one secret would have shared the owner's.
     */
    env: { HEDDLE_HOME: home, HOME: home, HEDDLE_CONFIG: config },
    args: ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'double', '--session-root', join(home, 'sessions')],
  }
}

/** Spawn the server and resolve once it prints its URL. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/check-helpers/lib.mjs')
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], {
        cwd: repoRoot,
        env: { ...process.env, NO_COLOR: '1', ...env },
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

async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('the printed URL carries a fresh per-process token', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const first = await startServer('fresh-1')
  const second = await startServer('fresh-2')
  const one = await startCli(first.args, first.env)
  const two = await startCli(second.args, second.env)
  try {
    const a = new URL(one.url).searchParams.get('token')
    const b = new URL(two.url).searchParams.get('token')
    assert.ok(a && a.length >= 32, `the token is long enough to be a secret\n${a}`)
    assert.notEqual(a, b, 'each process mints its own token, so a URL from one run is useless in the next')
  } finally {
    one.kill()
    two.kill()
    await first.double.close()
    await second.double.close()
    removeDir(first.home)
    removeDir(first.work)
    removeDir(second.home)
    removeDir(second.work)
  }
})

test('the token is exchanged for a cookie a script cannot read', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const fixture = await startServer('cookie')
  const server = await startCli(fixture.args, fixture.env)
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    assert.equal(handshake.status, 303, 'the root exchanges the token')
    const cookie = handshake.headers.get('set-cookie')
    assert.ok(cookie, 'a cookie is set')
    assert.match(cookie, /HttpOnly/, 'the cookie is not readable by script')
    assert.match(cookie, /SameSite=Strict/, 'and it is not sent from another site')
    assert.match(cookie, /Path=\//, 'and it applies to the whole UI')
    assert.match(handshake.headers.get('cache-control') ?? '', /no-store/, 'the exchange is not cached')
    assert.match(handshake.headers.get('referrer-policy') ?? '', /no-referrer/, 'and the token does not leak in a referrer')

    /**
     * The cookie is bound to the **authority**, so a cookie minted for one Host cannot be
     * replayed against another. That is DSH's rule and it is what makes a loopback service safe
     * on a machine where another process also listens.
     */
    const name = (cookie.split('=')[0] ?? '').trim()
    const port = new URL(server.url).port
    assert.notEqual(
      name,
      'heddle-auth',
      'the cookie name is derived from the authority rather than being a constant',
    )
    const other = await fetch(`http://localhost:${port}/api/sessions`, { headers: { cookie: cookie.split(';')[0] } })
    assert.equal(other.status, 401, 'the same cookie does not authenticate a different Host')
  } finally {
    server.kill()
    await fixture.double.close()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})

test('the API and the event stream are both refused without a token', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const fixture = await startServer('refuse')
  const server = await startCli(fixture.args, fixture.env)
  try {
    const port = new URL(server.url).port
    const api = await fetch(`http://127.0.0.1:${port}/api/sessions`)
    assert.equal(api.status, 401, 'the API refuses a request with no credential')
    assert.equal(await api.text(), 'unauthorized\n', 'and says so without leaking anything')

    const stream = await fetch(`http://127.0.0.1:${port}/api/events`)
    assert.equal(stream.status, 401, 'the event stream refuses it too')

    const wrong = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { cookie: 'heddle-auth-x=v1.1.forged' } })
    assert.equal(wrong.status, 401, 'a forged cookie is refused')

    const badToken = await fetch(`http://127.0.0.1:${port}/?token=definitely-not-the-token`, { redirect: 'manual' })
    assert.equal(badToken.status, 401, 'a wrong token is refused at the root')

    const turn = await fetch(`http://127.0.0.1:${port}/api/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'say something' }),
    })
    assert.equal(turn.status, 401, 'and taking an action needs one too')
  } finally {
    server.kill()
    await fixture.double.close()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})

test('a request from another site is refused before any token is compared', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const fixture = await startServer('fence')
  const server = await startCli(fixture.args, fixture.env)
  try {
    const handshake = await fetch(server.url, { redirect: 'manual' })
    const cookie = (handshake.headers.get('set-cookie') ?? '').split(';')[0]

    const crossSite = await fetch(new URL('/api/sessions', server.url), {
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(crossSite.status, 403, 'a cross-site request is refused with 403 rather than 401, so the refusal is about the request and not the credential')

    const foreignOrigin = await fetch(new URL('/api/sessions', server.url), {
      headers: { cookie, origin: 'https://evil.example' },
    })
    assert.equal(foreignOrigin.status, 403, 'and an Origin that is not this server is refused')

    const sameOrigin = await fetch(new URL('/api/sessions', server.url), {
      headers: { cookie, origin: `http://127.0.0.1:${new URL(server.url).port}` },
    })
    assert.equal(sameOrigin.status, 200, 'while the same origin is served')
  } finally {
    server.kill()
    await fixture.double.close()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})

test('the signing secret is mode 600 on reuse, not only at creation', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  /**
   * A secret that was 600 when it was made and world-readable later is the silent failure this part
   * is about: a signing secret is only a secret while nothing else can read it.
   *
   * Measured: the first version set the mode when writing the file and never looked again, so a copy
   * restored from a backup, or created by an older run, kept whatever mode it arrived with. The check
   * starts from a 644 file on purpose.
   */
  const { chmodSync, statSync } = await import('node:fs')
  const fixture = await startServer('secret-mode')
  try {
    // Start once so the secret exists, then make it world-readable and start again.
    const first = await startCli(fixture.args, fixture.env)
    first.kill()
    const secret = join(fixture.home, 'web-secret')
    chmodSync(secret, 0o644)
    assert.equal(statSync(secret).mode & 0o777, 0o644, 'the fixture really is world-readable')

    const second = await startCli(fixture.args, fixture.env)
    try {
      const mode = statSync(secret).mode & 0o777
      assert.equal(mode, 0o600, `the secret was tightened when it was reused (mode ${mode.toString(8)})`)
    } finally {
      second.kill()
    }
  } finally {
    await fixture.double.close()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})

test('a cookie is bound to the server that minted it, not to the secret alone', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  /**
   * Two processes, one signing secret on disk, different authorities. The first server's cookie is
   * **refused** by the second, and the second's launch token is not the first's.
   *
   * This is the claim worth checking, and it is a security property rather than a limitation: a
   * secret on disk is shared by every run on the machine, so if the cookie were signed by the secret
   * alone, a cookie minted for one server would be a valid credential for every other. Binding it to
   * the authority is what makes a loopback service safe beside another.
   *
   * Measured the other way first: this check started by asserting the cookie *was* accepted, which
   * failed — and the failure was the design working.
   */
  const one = await startServer('two-1')
  const shared = { ...one.env, HEDDLE_HOME: one.home, HOME: one.home }
  const two = await startServer('two-2')
  const second = await startCli(two.args, shared)
  try {
    const first = await startCli(one.args, one.env)
    try {
      const cookie = (await fetch(first.url, { redirect: 'manual' })).headers.get('set-cookie')?.split(';')[0]
      assert.ok(cookie, 'the first server minted a cookie')

      const port = new URL(second.url).port
      const replayed = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { cookie } })
      assert.equal(replayed.status, 401, 'the first server\'s cookie is not a credential for the second')

      const firstToken = new URL(first.url).searchParams.get('token')
      const wrongToken = await fetch(`http://127.0.0.1:${port}/api/sessions?token=${firstToken}`)
      assert.equal(wrongToken.status, 401, 'and neither is its launch token')

      // The second server still admits its own, so the refusals are about binding and not a broken server.
      const own = (await fetch(second.url, { redirect: 'manual' })).headers.get('set-cookie')?.split(';')[0]
      const admitted = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { cookie: own } })
      assert.equal(admitted.status, 200, 'while a cookie from the second server is accepted by it')
    } finally {
      first.kill()
    }
  } finally {
    second.kill()
    await one.double.close()
    await two.double.close()
    removeDir(one.home)
    removeDir(one.work)
    removeDir(two.home)
    removeDir(two.work)
  }
})

test('a stale launch token gets a page a person can recover from, not a dead end', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  /**
   * This is the bug the owner hit, and it took a **real browser** to find: a daemon mints a fresh launch
   * token on every start, so the URL in a browser's history, in a bookmark, or in scrollback is stale
   * after a restart. The old answer was `401 text/plain` reading "reopen the URL printed by `heddle web`"
   * — no page, no form, and no way forward but finding the log by hand. A refusal a person cannot act on
   * turns every restart into an outage.
   *
   * The claim: the stale-token refusal is a **document carrying the token form**, and it explains that the
   * token is not the current one.
   */
  const fixture = await startServer('stale-token')
  const server = await startCli(fixture.args, fixture.env)
  try {
    const origin = new URL(server.url).origin
    const stale = await fetch(`${origin}/?token=not-the-current-token`, { redirect: 'manual' })
    assert.equal(stale.status, 401, 'a stale token is refused')
    assert.match(stale.headers.get('content-type') ?? '', /text\/html/, 'and refused with a document rather than a sentence')
    const html = await stale.text()
    assert.match(html, /<form[^>]*action="\/"/, 'the document carries the form, so the current token can be pasted in')
    assert.match(html, /not the current one/i, 'and it says why the token stopped working')

    // The recovery path itself still works: a current token exchanges for a cookie.
    const fresh = await fetch(server.url, { redirect: 'manual' })
    assert.equal(fresh.status, 303, 'a current token still exchanges for a cookie')
  } finally {
    server.kill()
    await fixture.double.close()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})

test('a session\'s history is readable through the API, and a blank view is not the API\'s fault', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  /**
   * The bug this closes was found in a browser: every endpoint answered `200` while the right side of the
   * page stayed **empty** after a session was selected. The page's log region was written only by the live
   * event stream, so it had no way to show turns that had already happened, and nothing at the API level
   * was wrong to notice.
   *
   * So the API half is judged here: history exists, it is the *deltas* rather than the completed message
   * (the log records both, and reading both prints every answer twice), reasoning keeps its own kind, and
   * a request that is not a session id is refused rather than resolved as a path.
   */
  const fixture = await startServer('history')
  const server = await startCli(fixture.args, fixture.env)
  try {
    // One real turn, so there is history to read.
    const cookie = await handshakeCookie(server.url)
    const turn = await fetch(`${new URL(server.url).origin}/api/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ prompt: 'remember the word loom' }),
    })
    assert.equal(turn.status, 200, 'the turn that creates the history succeeded')
    await turn.text()

    const sessions = await (await fetch(`${new URL(server.url).origin}/api/sessions`, { headers: { cookie } })).json()
    assert.ok(Array.isArray(sessions) && sessions.length > 0, 'the session is listed')
    const id = sessions[0].id

    const history = await fetch(`${new URL(server.url).origin}/api/sessions/${id}`, { headers: { cookie } })
    assert.equal(history.status, 200, 'its history is readable')
    const body = await history.json()
    assert.equal(body.id, id, 'and it is that session')
    assert.ok(Array.isArray(body.turns) && body.turns.length > 0, `it holds turns\n${JSON.stringify(body).slice(0, 200)}`)
    const kinds = new Set(body.turns.map((entry) => entry.kind))
    assert.ok(kinds.has('user'), 'including what the person asked')
    assert.ok(kinds.has('assistant') || kinds.has('reasoning'), 'and what the model produced')
    assert.ok(
      body.turns.some((entry) => entry.text.includes('remember the word loom')),
      'with the user\'s words intact',
    )

    // A path that is not a session id must not be resolved against the store.
    const refused = await fetch(`${new URL(server.url).origin}/api/sessions/..%2F..%2Fetc%2Fpasswd`, { headers: { cookie } })
    assert.ok(refused.status === 400 || refused.status === 404, `a non-id is refused (HTTP ${refused.status})`)

    // And an id that does not exist is a 404 rather than an empty transcript.
    const missing = await fetch(`${new URL(server.url).origin}/api/sessions/session-00000000-0000-0000-0000-000000000000`, { headers: { cookie } })
    assert.equal(missing.status, 404, 'an unknown session is not found')
  } finally {
    server.kill()
    await fixture.double.close()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})

test('selecting a session shows its transcript in a real browser', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  /**
   * The check that would have caught the blank view, and the reason it is a browser check: the fault was
   * entirely in the page's own script — it fetched nothing to show — so no amount of API judging sees it.
   * Measured before the fix: 32 sessions listed and `#log` with a length of 0 after a click.
   *
   * `waitFor` is used rather than a fixed sleep, because a transcript that arrives late is working and a
   * check that says otherwise is a flaky one.
   */
  const fixture = await startServer('browser-history')
  const live = await startCli(fixture.args, fixture.env)
  const browser = await openBrowser()
  try {
    const origin = new URL(live.url).origin
    const cookie = await handshakeCookie(live.url)
    await fetch(`${origin}/api/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ prompt: 'the loom question' }),
    }).then((response) => response.text())

    /**
     * The browser is given the same cookie the handshake produced, which is the state a person is in after
     * visiting the printed URL. Setting it through `document.cookie` cannot work — heddle's cookie is
     * HttpOnly, which is the point of it — so the check navigates with the token once, exactly as the
     * printed URL asks a person to.
     */
    await browser.goto(live.url)
    assert.ok(await browser.waitFor('document.querySelectorAll("#sessions li").length > 0', 20_000), 'the session list rendered')

    await browser.evaluate('document.querySelector("#sessions li").click()')
    const shown = await browser.waitFor('document.getElementById("log").innerText.length > 0', 20_000)
    const text = await browser.evaluate('document.getElementById("log").innerText')
    assert.ok(shown, `selecting a session shows its transcript\nrendered: ${JSON.stringify(text.slice(0, 120))}`)
    assert.match(text, /loom/, "and it is that session's content")
  } finally {
    browser.close()
    live.kill()
    await fixture.double.close()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})
