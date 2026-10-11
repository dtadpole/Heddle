import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDouble, fixtureDir, httpConfig, isolatedHome, removeDir, runCli, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

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

async function startServer(label) {
  const home = isolatedHome(`token-${label}`)
  const work = fixtureDir(`token-${label}`)
  const double = await chatDouble({ content: 'live content', reasoning: 'live reasoning' })
  const config = httpConfig({ home, baseUrl: double.baseUrl, stream: true })
  return { home, work, double, config, args: ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'double', '--session-root', join(home, 'sessions')] }
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
  const one = await startCli(first.args, { HOME: first.home, HEDDLE_CONFIG: first.config })
  const two = await startCli(second.args, { HOME: second.home, HEDDLE_CONFIG: second.config })
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
  const server = await startCli(fixture.args, { HOME: fixture.home, HEDDLE_CONFIG: fixture.config })
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
  const server = await startCli(fixture.args, { HOME: fixture.home, HEDDLE_CONFIG: fixture.config })
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
  const server = await startCli(fixture.args, { HOME: fixture.home, HEDDLE_CONFIG: fixture.config })
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
