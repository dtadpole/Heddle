import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { browserAvailable, openBrowser } from '../../_tools_/check-helpers/browser.mjs'
import { fixtureDir, isolatedHome, removeDir, runCli, scriptedConfig, skipUnless } from '../../_tools_/check-helpers/lib.mjs'

/**
 * Verifier — the resizable panels.
 *
 * Judges one claim: a reader can decide how much room the sidebar gets, with a mouse **or** a keyboard, and
 * the choice is remembered.
 *
 * The failure modes being guarded are the ones a screenshot cannot show: a divider that looks draggable and
 * is not (an early version called `setPointerCapture` unguarded, and a pointer the browser is not tracking
 * threw before the listeners were bound, so the drag did nothing), a drag that stops working when the
 * pointer leaves the divider, a width that can be dragged past the point where the content vanishes, and a
 * choice forgotten on reload.
 */

const CAPABILITY = 'a resizable sidebar driven by pointer and keyboard, with the width remembered'

/** Start the Web UI and resolve once it prints its URL. */
function startCli(args, env) {
  return new Promise((resolvePromise, reject) => {
    void (async () => {
      const { spawn } = await import('node:child_process')
      const { repoRoot } = await import('../../_tools_/check-helpers/lib.mjs')
      const { join: joinPath } = await import('node:path')
      const child = spawn(process.execPath, [joinPath(repoRoot, 'dist', 'cli.js'), ...args], {
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

/** Whether this build serves a Web UI at all. */
async function supportsWeb() {
  const help = await runCli(['--help'])
  return /web/.test(help.stdout)
}

test('the sidebar is resizable by pointer and by keyboard, and the width is remembered', async (context) => {
  if (!skipUnless(context, await supportsWeb(), CAPABILITY)) return
  if (!skipUnless(context, browserAvailable(), 'a browser on this machine')) return

  const home = isolatedHome('resize')
  const work = fixtureDir('resize')
  const { config } = scriptedConfig({ home, steps: [{ text: 'ready' }] })
  const server = await startCli(['web', '--host', '127.0.0.1', '--port', '0', '--session-root', join(home, 'sessions')], {
    HEDDLE_HOME: home,
    HEDDLE_CONFIG: config,
  })
  const browser = await openBrowser({ width: 1400, height: 800 })
  try {
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("gutter-left") !== null', 20_000), 'the divider is there')

    /**
     * The divider is a control, not a styled border: `role="separator"` with a tabindex is what makes it
     * keyboard reachable, and the value attributes are what let assistive technology report the width.
     */
    const separator = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        return JSON.stringify({
          role: gutter.getAttribute('role'),
          orientation: gutter.getAttribute('aria-orientation'),
          tabindex: gutter.tabIndex,
          hasValue: gutter.hasAttribute('aria-valuenow'),
          cursor: getComputedStyle(gutter).cursor
        })
      })()`),
    )
    assert.equal(separator.role, 'separator', 'it is a separator')
    assert.equal(separator.orientation, 'vertical', 'oriented with the edge it moves')
    assert.ok(separator.tabindex >= 0, 'and reachable by keyboard')
    assert.ok(separator.hasValue, 'with a value a screen reader can report')
    assert.equal(separator.cursor, 'col-resize', 'and a cursor that says it can be dragged')

    /** Drag it wider, the way a person does, with a pointer that has coordinates. */
    const dragged = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        const sidebar = document.querySelector('aside')
        const before = Math.round(sidebar.getBoundingClientRect().width)
        const box = gutter.getBoundingClientRect()
        const fire = (type, clientX) => {
          const event = new Event(type, { bubbles: true })
          event.clientX = clientX
          event.clientY = box.top + box.height / 2
          event.pointerId = 1
          gutter.dispatchEvent(event)
        }
        fire('pointerdown', box.left + 1)
        fire('pointermove', box.left + 1 + 160)
        fire('pointerup', box.left + 1 + 160)
        return JSON.stringify({
          before,
          after: Math.round(sidebar.getBoundingClientRect().width),
          stored: Number(localStorage.getItem('heddle.layout.sidebar.v1'))
        })
      })()`),
    )
    assert.ok(dragged.after > dragged.before + 100, `dragging right widens the sidebar (${dragged.before} -> ${dragged.after})`)
    assert.ok(Math.abs(dragged.stored * 16 - dragged.after) <= 2, `and the stored width matches what is drawn (${dragged.stored}rem)`)

    /**
     * Dragging past the limits. A sidebar wider than the window's share leaves nothing to work in, and a
     * negative width is not a width — both read as the app being broken rather than as a choice.
     */
    const clamped = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        const sidebar = document.querySelector('aside')
        const box = gutter.getBoundingClientRect()
        const fire = (type, clientX) => {
          const event = new Event(type, { bubbles: true })
          event.clientX = clientX
          event.clientY = box.top + box.height / 2
          event.pointerId = 1
          gutter.dispatchEvent(event)
        }
        fire('pointerdown', box.left + 1)
        fire('pointermove', window.innerWidth * 3)
        fire('pointerup', window.innerWidth * 3)
        const widest = Math.round(sidebar.getBoundingClientRect().width)
        fire('pointerdown', box.left + 1)
        fire('pointermove', -9999)
        fire('pointerup', -9999)
        return JSON.stringify({
          widest,
          narrowest: Math.round(sidebar.getBoundingClientRect().width),
          viewport: window.innerWidth,
          contentVisible: document.querySelector('main').getBoundingClientRect().width > 100
        })
      })()`),
    )
    assert.ok(clamped.widest < clamped.viewport * 0.9, `a drag past the limit leaves room to work (${clamped.widest}px of ${clamped.viewport}px)`)
    assert.ok(clamped.contentVisible, 'and the content is still there')
    assert.ok(clamped.narrowest >= 190, `and the sidebar cannot be dragged away entirely (${clamped.narrowest}px)`)

    /** The keyboard path, because a control that only works with a mouse is half a control. */
    const keyboard = JSON.parse(
      await browser.evaluate(`(() => {
        const gutter = document.getElementById('gutter-left')
        const sidebar = document.querySelector('aside')
        gutter.focus()
        const before = Math.round(sidebar.getBoundingClientRect().width)
        for (let index = 0; index < 3; index += 1) gutter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        const afterRight = Math.round(sidebar.getBoundingClientRect().width)
        gutter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
        return JSON.stringify({ before, afterRight, afterLeft: Math.round(sidebar.getBoundingClientRect().width), focused: document.activeElement === gutter })
      })()`),
    )
    assert.ok(keyboard.focused, 'the divider takes focus')
    assert.ok(keyboard.afterRight > keyboard.before, `and the arrow keys move it (${keyboard.before} -> ${keyboard.afterRight})`)
    assert.ok(keyboard.afterLeft < keyboard.afterRight, 'in both directions')

    /** The choice survives a reload, or it was never a choice. */
    const remembered = Number(await browser.evaluate('localStorage.getItem("heddle.layout.sidebar.v1")'))
    await browser.goto(server.url)
    assert.ok(await browser.waitFor('document.getElementById("gutter-left") !== null', 20_000), 'the page came back')
    const restored = await browser.evaluate(`Math.round(document.querySelector('aside').getBoundingClientRect().width)`)
    assert.ok(
      Math.abs(restored - remembered * 16) <= 2,
      `the width is restored after a reload (${remembered}rem drawn as ${restored}px)`,
    )
    assert.equal(
      await browser.evaluate('document.getElementById("gutter-left").getAttribute("aria-valuenow")'),
      String(Math.round(remembered)),
      'and the control reports the width it is showing',
    )
  } finally {
    browser.close()
    server.kill()
    removeDir(home)
    removeDir(work)
  }
})
