import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { chatDouble, fixtureDir, isolatedHome, removeDir, skipUnless, writeJson } from '../../_tools_/check-helpers/lib.mjs'

/**
 * The composer's submission gestures and the queue buffer, judged in a browser.
 *
 * The claim is the one the owner asked for: **Enter sends, and while a turn is running it queues; Ctrl+Enter
 * sends the queued message** — with the queue visible as a buffer above the composer and the primary action
 * drawn as DSH's arrow rather than a `Run` button. Every rule follows DSH's own input bar
 * (`resolveSubmitMode`, `busyEnter` defaulting to `queue`, `QueueDock`, `steerQueue`), and each assertion here
 * is one of those rules rather than a rendering detail:
 *
 * - a submit with nothing running starts its turn immediately — the queue is not a two-step send;
 * - a submit while a turn runs lands in the buffer, drawn as DSH draws it: a count header when several are
 *   waiting, folded closed;
 * - the accelerated chord (Ctrl+Enter) puts its message **ahead of** one queued earlier, which is heddle's
 *   honest form of DSH's `steer`: a session's log takes one writer, so "send this next" is the most a steer
 *   can mean here;
 * - the same chord with an empty draft sends everything still waiting, in FIFO order;
 * - the arrow button submits exactly what Enter would.
 */

const CAPABILITY = 'a Web UI on localhost with a live stream'

/**
 * Wait for a node-side fact — what a double received — to become true.
 *
 * A page-side condition is waited for with `browser.waitFor`, but the double's request count is on this side
 * of the socket and lands a moment **after** the page has marked the message as sent. Asserting it
 * immediately is a race, and one this check lost: measured, the composer drew the queue and the request had
 * not arrived yet.
 */
async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  return predicate()
}

/** A run whose server prints its URL, with a double that holds its terminator open so a turn is observably running. */
async function startServer(label, options = {}) {
  const home = isolatedHome(`composer-${label}`)
  const work = fixtureDir(`composer-${label}-work`)
  const double = await chatDouble({
    content: options.content ?? 'the answer',
    reasoning: 'thinking',
    holdOpenMs: options.holdOpenMs ?? 1200,
  })
  const config = writeJson(join(home, 'heddle.json'), {
    default: 'held',
    endpoints: [{ name: 'held', kind: 'openai-chat', baseUrl: double.baseUrl, model: 'held-model', stream: true }],
  })
  const child = await startCli(
    ['web', '--host', '127.0.0.1', '--port', '0', '--endpoint', 'held', '--session-root', join(home, 'sessions')],
    { env: { HEDDLE_CONFIG: config } },
  )
  return {
    double,
    url: child.url,
    close: async () => {
      child.kill()
      await double.close()
      removeDir(home)
      removeDir(work)
    },
  }
}

/** Spawn the CLI and resolve once it prints its URL, or reject on exit. */
function startCli(args, options) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/check-helpers/lib.mjs')
      const child = spawn(process.execPath, [join(repoRoot, 'dist', 'cli.js'), ...args], {
        cwd: repoRoot,
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
 * Type a draft and press a key, the way a person does.
 *
 * The value is written and a **keydown** is dispatched rather than the form being submitted directly: the
 * gesture is the claim, and `requestSubmit()` would judge the handler while skipping the keymap that decides
 * which gesture it is.
 */
const type = (browser, text) =>
  browser.evaluate(`(() => { const field = document.querySelector('textarea'); field.value = ${JSON.stringify(text)}; return true })()`)
const press = (browser, init) =>
  browser.evaluate(`(() => {
    const field = document.querySelector('textarea')
    field.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(init)}))
    return true
  })()`)

test('the composer queues with Enter while a turn runs, and Ctrl+Enter sends what is queued', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('queue')
  const browser = await openBrowser({ width: 1280, height: 900 })
  try {
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("model-trigger") !== null', 20_000), 'the panel is up')

    /**
     * Nothing running: Enter sends. The claim is DSH's `resolveSubmitMode` answer for an idle agent —
     * `queue`, which its host drains at once — so what a person sees is an ordinary send.
     */
    await type(browser, 'first')
    await press(browser, { key: 'Enter' })
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("first")', 10_000), 'the message was sent')
    assert.equal(server.double.requests.length, 1, 'and the endpoint was asked once, without a second gesture')

    /**
     * A turn is running, so plain Enter queues and the dock appears. The header counts what is waiting and
     * starts **closed**, which is DSH's `QueueDock`: a count for more than one row, one row drawn directly.
     *
     * The row **being delivered counts too** — it stays in the dock with a `Sending…` status until its turn
     * ends, which is what DSH does with a local submission whose host row has not arrived yet, and it is why
     * the two presses below read as three.
     */
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === false', 10_000), 'the queue is shown while the turn runs')
    await type(browser, 'second')
    await press(browser, { key: 'Enter' })
    await type(browser, 'third')
    await press(browser, { key: 'Enter' })
    const dock = JSON.parse(
      await browser.evaluate(`JSON.stringify({
        header: (document.querySelector('#queue .header') || {}).textContent || '',
        status: (document.querySelector('#queue .status') || {}).textContent || '',
        listHidden: (document.querySelector('#queue .list') || {}).hidden,
        label: document.getElementById('send').getAttribute('aria-label')
      })`),
    )
    assert.match(dock.header, /3 queued messages/, `the header says how many are in the dock (${dock.header})`)
    assert.equal(dock.listHidden, true, 'and the rows are folded away until asked for')
    assert.equal(dock.label, 'Queue message', 'the arrow says what pressing it will do while a turn runs')

    /** The header is the disclosure, so opening it shows the rows — one per message in the dock. */
    await browser.evaluate('document.querySelector("#queue .header").click()')
    assert.equal(await browser.evaluate('document.querySelectorAll("#queue .row").length'), 3, 'opening the header shows every row')
    assert.equal(
      await browser.evaluate('(document.querySelector("#queue .status") || {}).textContent || ""'),
      'Sending…',
      'and the one being delivered says so',
    )

    /**
     * The accelerated chord goes **next**, not last: DSH resolves Ctrl/Cmd+Enter to the opposite delivery
     * mode, and heddle's opposite of "wait" is "go to the front of the wait". The order in the transcript is
     * the evidence, and it is why this check reads the log rather than counting requests.
     */
    await type(browser, 'urgent')
    await press(browser, { key: 'Enter', ctrlKey: true })
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === true', 30_000), 'the queue drains on its own')
    const log = await browser.evaluate('document.getElementById("log").innerText')
    const order = ['first', 'urgent', 'second', 'third'].map((text) => log.indexOf(text))
    assert.ok(order.every((at) => at !== -1), `every message was sent (${log})`)
    assert.deepEqual(
      [...order].sort((left, right) => left - right),
      order,
      `the accelerated message went ahead of the ones queued before it (${JSON.stringify(order)})`,
    )
    assert.equal(server.double.requests.length, 4, 'each message was one turn')

    /** The arrow button is the same gesture as Enter, which is DSH's rule for its primary action. */
    await type(browser, 'by button')
    await browser.evaluate('document.getElementById("send").click()')
    assert.ok(await browser.waitFor('document.getElementById("log").innerText.includes("by button")', 15_000), 'the arrow sends the draft')
    assert.equal(server.double.requests.length, 5, 'and that was one more turn')
  } finally {
    browser.close()
    await server.close()
  }
})

test('Ctrl+Enter on an empty draft sends everything still queued, in order', async (context) => {
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('chord', { holdOpenMs: 1500 })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("model-trigger") !== null', 20_000)

    await type(browser, 'running')
    await press(browser, { key: 'Enter' })
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === false', 10_000), 'the first turn is running')
    for (const text of ['queued one', 'queued two', 'queued three']) {
      await type(browser, text)
      await press(browser, { key: 'Enter' })
    }
    const waiting = await browser.evaluate('document.querySelector("#queue .header").textContent')
    assert.match(waiting, /4 queued messages/, `three wait behind the one being delivered (${waiting})`)

    /** The empty draft is the point: the chord means "send the queue", not "send this draft". */
    await type(browser, '')
    await press(browser, { key: 'Enter', ctrlKey: true })
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === true', 40_000), 'the whole queue was delivered')
    const log = await browser.evaluate('document.getElementById("log").innerText')
    const order = ['running', 'queued one', 'queued two', 'queued three'].map((text) => log.indexOf(text))
    assert.ok(order.every((at) => at !== -1), `every queued message was sent (${log})`)
    assert.deepEqual([...order].sort((left, right) => left - right), order, 'in FIFO order')
    assert.equal(server.double.requests.length, 4, 'one turn per message, including the one that was running')
  } finally {
    browser.close()
    await server.close()
  }
})

test('a steered message is answered by the running turn, and a steer with nothing running is refused', async (context) => {
  /**
   * The half of steering the composer cannot do alone, and the reason it is not just a queue reorder.
   *
   * DSH's agent runtime injects a steered message between steps; heddle appends it to the session and the
   * **loop** has to take another round, because an answer with no tool calls used to end the turn and leave the
   * message sitting in the transcript unanswered. The route's refusal is DSH's too: `session/steer-unavailable`
   * when the turn it would be delivered into has ended.
   */
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return
  const server = await startServer('steer', { holdOpenMs: 1500 })
  const browser = await openBrowser()
  try {
    await browser.goto(server.url)
    await browser.waitFor('document.getElementById("model-trigger") !== null', 20_000)

    const refused = await browser.evaluate(`fetch('/api/sessions/session-00000000-0000-0000-0000-000000000000/steer', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'nobody is running' })
    }).then((response) => response.status)`)
    assert.equal(refused, 409, 'a steer with no running turn is refused, as DSH refuses it')

    await type(browser, 'the first question')
    await press(browser, { key: 'Enter' })
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === false', 10_000), 'the turn is running')
    assert.ok(await until(() => server.double.requests.length === 1), 'one model call is in flight')

    await type(browser, 'answer this too')
    await press(browser, { key: 'Enter', ctrlKey: true })
    assert.ok(
      await browser.waitFor('document.getElementById("log").innerText.includes("answer this too")', 15_000),
      'the steered message reached the transcript',
    )
    assert.ok(await browser.waitFor('document.getElementById("queue").hidden === true', 40_000), 'the turn ends')
    assert.ok(await until(() => server.double.requests.length === 2), 'and the running turn asked the model again for it')
    const log = await browser.evaluate('document.getElementById("log").innerText')
    assert.ok(log.includes('the answer'), 'the steered message was answered inside that turn')
  } finally {
    browser.close()
    await server.close()
  }
})
