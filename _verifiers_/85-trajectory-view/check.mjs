import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { chatDouble, fixtureDir, httpConfig, isolatedHome, removeDir, runCli, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier — the Trajectory view.
 *
 * Judges one claim: a session can be read **two ways** — as the conversation it was, and as the ledger of what
 * the harness did — and the two cannot disagree about it.
 *
 * It is a browser check because the failure mode this guards is a view that answers `200` and renders
 * nothing, which is exactly how the Chat view's history broke once and no API-level check could see it. The
 * API half is judged too, because the ledger's shape is a contract: turn, step, kind, timing and usage must
 * be **fields**, not prose a check would have to parse.
 */

const CAPABILITY = 'two views of one session: the conversation, and the ledger of what the harness did'

/**
 * Start the Web UI and resolve once it prints its URL.
 *
 * `runCli` waits for the process to exit, which a server never does — measured, and it is why the first
 * version of this check failed with "the server answered with a URL" while the server was running fine.
 */
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
        if (!settled) reject(new Error(`the server exited ${code} before printing a URL\n${output}`))
      })
    })()
  })
}

/** Start a server with a scripted model and hand back everything a check needs to stop it. */
async function startServer(label) {
  const home = isolatedHome(`trajectory-${label}`)
  const work = fixtureDir(`trajectory-${label}`)
  const { config } = (await import('../../_tools_/check-helpers/lib.mjs')).scriptedConfig({
    home,
    steps: [
      { toolCall: { name: 'bash', arguments: { command: 'pwd' } } },
      { text: 'the answer' },
    ],
  })
  return {
    home,
    work,
    config,
    env: { HEDDLE_HOME: home, HEDDLE_CONFIG: config },
    args: ['--session-root', join(home, 'sessions'), '--sandbox-root', work, '--endpoint', 'scripted'],
  }
}

/** Exchange a server's launch URL for the cookie heddle issues. */
async function handshakeCookie(url) {
  const response = await fetch(url, { redirect: 'manual' })
  const set = response.headers.get('set-cookie')
  if (set === null) throw new Error(`no cookie from ${url} (HTTP ${response.status})`)
  return set.split(';')[0]
}

/** Run one turn that uses a tool, so the ledger has something with timing and usage to project. */
async function runOneTurn(server, cookie) {
  const origin = new URL(server.url).origin
  const turn = await fetch(`${origin}/api/turn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ prompt: 'run pwd and answer' }),
  })
  assert.equal(turn.status, 200, 'the turn that fills the ledger succeeded')
  await turn.text()
  return origin
}

test('the ledger is a projection of the recorded events, in fields rather than prose', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  const fixture = await startServer('api')
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', ...fixture.args], fixture.env)
  try {
    const cookie = await handshakeCookie(server.url)
    await runOneTurn(server, cookie)
    const origin = new URL(server.url).origin
    const sessions = await (await fetch(`${origin}/api/sessions`, { headers: { cookie } })).json()
    const id = sessions[0].id

    const body = await (await fetch(`${origin}/api/sessions/${id}?view=ledger`, { headers: { cookie } })).json()
    assert.ok(body.ledger, 'the response carries a ledger')
    assert.equal(body.id, id, 'for the session asked for')
    assert.ok(Array.isArray(body.ledger.turns) && body.ledger.turns.length > 0, 'with turns')

    const turn = body.ledger.turns[0]
    assert.ok(Array.isArray(turn.steps) && turn.steps.length > 0, 'each turn has steps')
    assert.equal(typeof turn.index, 'number', 'a turn is numbered')
    const step = turn.steps[0]
    assert.equal(typeof step.index, 'number', 'and a step is numbered')

    const records = turn.steps.flatMap((entry) => entry.records)
    const kinds = new Set(records.map((record) => record.kind))
    assert.ok(kinds.has('user'), 'the prompt is a record')
    assert.ok(kinds.has('tool') || kinds.has('assistant'), 'and so is what the harness did about it')
    for (const record of records) {
      assert.equal(typeof record.kind, 'string', 'every record names its kind as a field')
      assert.equal(typeof record.label, 'string', 'and has a label')
      assert.equal(typeof record.text, 'string', 'and its text')
    }

    /**
     * The two rules a reader would believe if they were wrong: a duration only where the events measure one,
     * and a token count only where one was reported.
     */
    const running = records.filter((record) => record.inFlight === true)
    assert.ok(running.every((record) => record.durationMs === undefined), 'an in-flight record carries no duration')
    const withUsage = records.filter((record) => record.usage !== undefined)
    assert.ok(withUsage.length > 0, 'at least the request carries a token count')
    assert.ok(
      withUsage.every((record) => record.usageSource === 'provider' || record.usageSource === 'estimated'),
      'and every count says where it came from',
    )
    assert.equal(body.ledger.inFlight, running.length, 'the ledger counts its in-flight records')

    /**
     * One route, two views. The Chat projection must still answer on the same path, because a second route is
     * how two views of one record start to disagree.
     */
    const chat = await (await fetch(`${origin}/api/sessions/${id}`, { headers: { cookie } })).json()
    assert.ok(Array.isArray(chat.turns), 'the same route still serves the conversation')
    assert.ok(
      chat.turns.some((entry) => entry.text.includes('run pwd')),
      'and it holds the same prompt the ledger does',
    )

    const refused = await fetch(`${origin}/api/sessions/not-a-session?view=ledger`, { headers: { cookie } })
    assert.ok(refused.status === 400 || refused.status === 404, `a non-id is refused (HTTP ${refused.status})`)
  } finally {
    server.kill()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})

test('a browser renders the ledger, its timeline, and switches back to the conversation', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const fixture = await startServer('browser')
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', ...fixture.args], fixture.env)
  const browser = await openBrowser()
  try {
    const cookie = await handshakeCookie(server.url)
    await runOneTurn(server, cookie)

    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.querySelectorAll("#sessions li").length > 0', 20_000), 'the session list rendered')

    const tabs = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('#views button')].map((b) => b.textContent))`))
    assert.deepEqual(tabs, ['Chat', 'Trajectory'], 'the view ring offers both views')

    await browser.evaluate(`document.querySelector('#views button[data-view="trajectory"]').click()`)
    assert.ok(await browser.waitFor('document.querySelectorAll("#ledger details.record").length > 0', 20_000), 'the ledger drew records')

    const drawn = JSON.parse(
      await browser.evaluate(`(() => {
        const rows = [...document.querySelectorAll('#ledger details.record')]
        return JSON.stringify({
          rows: rows.length,
          withKind: rows.filter((r) => (r.querySelector('.kind') || {}).innerText).length,
          oneLine: rows.every((r) => {
            const summary = r.querySelector(':scope > summary')
            return Math.round(summary.getBoundingClientRect().height / parseFloat(getComputedStyle(summary).lineHeight)) === 1
          }),
          closed: rows.every((r) => !r.hasAttribute('open')),
          ellipsis: rows.every((r) => getComputedStyle(r.querySelector('.label')).textOverflow === 'ellipsis'),
          chatHidden: document.getElementById('log').hidden
        })
      })()`),
    )
    assert.ok(drawn.rows > 0, 'there are rows')
    assert.equal(drawn.withKind, drawn.rows, 'every row carries its kind as an annotation')
    assert.ok(drawn.oneLine, 'every row is one line')
    assert.ok(drawn.closed, 'and closed by default, so a long ledger stays navigable')
    assert.ok(drawn.ellipsis, 'with a label that truncates rather than wrapping')
    assert.ok(drawn.chatHidden, 'while the conversation is hidden')

    // A row opens to its full input and output.
    await browser.evaluate(`document.querySelector('#ledger details.record > summary').click()`)
    const opened = JSON.parse(
      await browser.evaluate(`JSON.stringify({ open: document.querySelectorAll('#ledger details.record[open]').length, bodyChars: (document.querySelector('#ledger details.record[open] pre') || { innerText: '' }).innerText.length })`),
    )
    assert.equal(opened.open, 1, 'clicking a row opens it')
    assert.ok(opened.bodyChars > 0, 'and its record is there to read')

    // The timeline: present, proportional, pickable, and it moves the ledger.
    const timeline = JSON.parse(
      await browser.evaluate(`(() => {
        const band = document.getElementById('timeline')
        const segments = [...band.querySelectorAll('button')]
        return JSON.stringify({
          exists: band !== null,
          segments: segments.length,
          proportional: segments.every((s) => parseFloat(s.style.left) >= 0 && parseFloat(s.style.left) <= 100 && parseFloat(s.style.width) >= 2),
          labelled: segments.every((s) => /turn \\d+/.test(s.getAttribute('aria-label') || '')),
          legend: (document.getElementById('timeline-legend') || { innerText: '' }).innerText
        })
      })()`),
    )
    assert.ok(timeline.exists, 'the timeline exists')
    assert.ok(timeline.segments >= 1, 'with a segment per turn')
    assert.ok(timeline.proportional, 'each positioned along the axis and wide enough to pick')
    assert.ok(timeline.labelled, 'and named by its turn')
    assert.match(timeline.legend, /recorded/, 'with the recorded span stated')

    await browser.evaluate(`document.querySelector('#timeline button').click()`)
    assert.ok(
      await browser.waitFor(`document.querySelector('#timeline button[aria-current="true"]') !== null`, 5_000),
      'picking a segment marks it as the one being shown',
    )

    await browser.evaluate(`document.querySelector('#views button[data-view="chat"]').click()`)
    assert.ok(await browser.waitFor('!document.getElementById("log").hidden', 5_000), 'and Chat comes back')
    assert.ok(await browser.evaluate('document.getElementById("ledger").hidden'), 'with the ledger put away')
  } finally {
    browser.close()
    server.kill()
    removeDir(fixture.home)
    removeDir(fixture.work)
  }
})

/** Whether this build serves a Web UI at all. */
async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}
