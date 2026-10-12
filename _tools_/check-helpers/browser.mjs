import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A browser, driven over Chrome's DevTools protocol, with nothing installed.
 *
 * A unit test cannot see the class of bug this exists for. The Web UI's own history view was **blank**
 * while every endpoint it needed answered `200`: the page's log region was written only by the live
 * `EventSource`, so selecting a session set the id it filtered on and then had nothing to show. Nothing
 * but a browser could tell that apart from a working page, which is why this lives here — and why the
 * check that uses it is the one that would have caught it.
 *
 * `--dump-dom` was the obvious tool and is not usable: it returns the DOM **once**, after load, so it
 * cannot look after a click, and it does not return at all while a page holds an `EventSource` open —
 * measured, it hung until it was killed on this very UI. So this speaks the protocol and reads the page
 * when the check asks.
 *
 * Deliberately dependency-free: a browser check that needs a package manager is unavailable on a machine
 * that has only Chrome and Node.
 */

/** Where Chrome usually lives, and the alternatives worth trying. */
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]

/** The first browser binary that exists, or `undefined`. */
export function browserPath() {
  return CANDIDATES.find((candidate) => existsSync(candidate))
}

/** Whether a browser is available, so a check can report unjudged instead of failing. */
export function browserAvailable() {
  return browserPath() !== undefined
}

function encodeFrame(payload) {
  const data = Buffer.from(payload)
  const mask = randomBytes(4)
  const header = [0x81]
  if (data.length < 126) header.push(0x80 | data.length)
  else if (data.length < 65_536) header.push(0x80 | 126, (data.length >> 8) & 0xff, data.length & 0xff)
  else header.push(0x80 | 127, 0, 0, 0, 0, (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff)
  const masked = Buffer.alloc(data.length)
  for (let index = 0; index < data.length; index += 1) masked[index] = data[index] ^ mask[index % 4]
  return Buffer.concat([Buffer.from(header), mask, masked])
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null
  const short = buffer[1] & 0x7f
  let offset = 2
  let length = short
  if (short === 126) {
    if (buffer.length < 4) return null
    length = (buffer[2] << 8) | buffer[3]
    offset = 4
  } else if (short === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const masked = (buffer[1] & 0x80) !== 0
  let mask
  if (masked) {
    if (buffer.length < offset + 4) return null
    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return null
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
  return { payload, consumed: offset + length, opcode: buffer[0] & 0x0f }
}

async function connect(url) {
  const parsed = new URL(url)
  const key = randomBytes(16).toString('base64')
  const socket = net.connect(Number(parsed.port), parsed.hostname)

  let buffer = Buffer.alloc(0)
  let nextId = 1
  const waiters = new Map()
  const eventWaiters = new Map()
  const listeners = new Map()

  const dispatch = () => {
    for (;;) {
      const frame = decodeFrame(buffer)
      if (frame === null) return
      buffer = buffer.subarray(frame.consumed)
      if (frame.opcode !== 0x1) continue
      let message
      try {
        message = JSON.parse(frame.payload.toString('utf8'))
      } catch {
        continue
      }
      if (typeof message.id === 'number') {
        const waiter = waiters.get(message.id)
        if (waiter !== undefined) {
          waiters.delete(message.id)
          waiter(message)
        }
        continue
      }
      if (typeof message.method === 'string') {
        listeners.get(message.method)?.(message.params ?? {})
        const waiting = eventWaiters.get(message.method)
        if (waiting !== undefined) {
          eventWaiters.delete(message.method)
          waiting(message)
        }
      }
    }
  }

  await new Promise((resolvePromise, reject) => {
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write(
        `GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.host}\r\nUpgrade: websocket\r\n` +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      )
    })
    socket.once('data', (chunk) => {
      const text = chunk.toString('utf8')
      if (!text.includes('101')) {
        reject(new Error(`the devtools handshake failed: ${text.split('\r\n')[0]}`))
        return
      }
      buffer = Buffer.concat([buffer, chunk.subarray(chunk.indexOf('\r\n\r\n') + 4)])
      socket.on('data', (next) => {
        buffer = Buffer.concat([buffer, next])
        dispatch()
      })
      socket.on('error', () => {})
      resolvePromise()
    })
  })

  return {
    on: (method, handler) => listeners.set(method, handler),
    send: (method, params = {}) =>
      new Promise((resolvePromise) => {
        const id = nextId++
        waiters.set(id, resolvePromise)
        socket.write(encodeFrame(JSON.stringify({ id, method, params })))
      }),
    once: (method, timeoutMs) =>
      new Promise((resolvePromise) => {
        eventWaiters.set(method, resolvePromise)
        setTimeout(() => {
          if (eventWaiters.has(method)) {
            eventWaiters.delete(method)
            resolvePromise(null)
          }
        }, timeoutMs)
      }),
    close: () => socket.destroy(),
  }
}

/**
 * Open a browser and return a page you can look at more than once.
 *
 * The caller must `close()`, which kills the browser and removes the profile it was given.
 */
export async function openBrowser(options = {}) {
  const binary = options.binary ?? browserPath()
  if (binary === undefined) throw new Error('no browser binary was found')
  const profile = mkdtempSync(join(tmpdir(), 'heddle-check-browser-'))
  const child = spawn(
    binary,
    [
      ...(options.visible === true ? ['--new-window'] : ['--headless=new']),
      '--disable-gpu',
      /**
       * The appearance the page is told the reader prefers.
       *
       * A light or dark theme is a real claim and it needs both to be judgeable: a page that follows the system
       * (`color-scheme: light dark`) can be entirely unreadable in one of the two, and measured was exactly that — a
       * palette written for a dark background left a source file washed out on a light one. Without this flag a check
       * can only ever see whichever appearance the host happens to be set to.
       */
      ...(options.colorScheme === 'light' ? ['--force-light-mode'] : options.colorScheme === 'dark' ? ['--force-dark-mode'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${options.width ?? 1280},${options.height ?? 900}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const wsUrl = await new Promise((resolvePromise, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`the browser printed no debugging endpoint within 20s\n${output}`)), 20_000)
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
      const match = /ws:\/\/[^\s]+/.exec(output)
      if (match !== null) {
        clearTimeout(timer)
        resolvePromise(match[0])
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the browser exited ${code} before printing an endpoint\n${output}`))
    })
  })

  /**
   * The endpoint Chrome prints is the **browser** target, and page commands need the page target's own
   * socket — measured, and it fails quietly: the browser endpoint accepted `Runtime.evaluate` and never
   * answered, so every lookup came back `undefined`.
   */
  const port = new URL(wsUrl).port
  const targets = await new Promise((resolvePromise, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/json/list' }, (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk.toString()
        })
        response.on('end', () => {
          try {
            resolvePromise(JSON.parse(body))
          } catch (error) {
            reject(new Error(`could not read the target list: ${error.message}`))
          }
        })
      })
      .on('error', reject)
  })
  const page = targets.find((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
  if (page === undefined) throw new Error('no page target was exposed to attach to')

  const connection = await connect(page.webSocketDebuggerUrl)
  await connection.send('Page.enable')
  await connection.send('Runtime.enable')

  /**
   * The live execution context, which a navigation replaces. An evaluation sent without naming the live
   * context — or between the old one dying and the new one existing — is answered with an empty remote
   * object rather than an error, so a reading after navigation came back `undefined` on a page that had a
   * value. `Runtime.executionContextCreated` names each context.
   *
   * **The main frame's context, not the newest one.** A page with an `iframe` — heddle's own HTML preview
   * builds one, sandboxed — creates a second default context, and taking the last one created pointed every
   * reading at the frame instead of the page: measured on 2026-10-12, `location.href` answered `about:blank`
   * while the raw protocol answered the server's URL, because the iframe's context was the last to arrive.
   * Contexts are therefore kept **by frame** and the top frame's is chosen; `Page.frameNavigated` names the
   * top frame, since a subframe has a `parentId` and it does not.
   */
  const contexts = new Map()
  let fallbackContextId
  let mainFrameId
  connection.on('Page.frameNavigated', (params) => {
    const frame = params?.frame
    if (frame !== undefined && frame.parentId === undefined) mainFrameId = frame.id
  })
  connection.on('Runtime.executionContextCreated', (params) => {
    const context = params?.context
    if (context === undefined || context.auxData?.isDefault !== true) return
    const frameId = context.auxData?.frameId
    if (typeof frameId === 'string') contexts.set(frameId, context.id)
    else if (fallbackContextId === undefined) fallbackContextId = context.id
  })
  connection.on('Runtime.executionContextsCleared', () => {
    contexts.clear()
    fallbackContextId = undefined
  })
  /** The top frame's context when it is known, and the only default context seen otherwise. */
  const liveContextId = () => (mainFrameId !== undefined ? contexts.get(mainFrameId) : undefined) ?? fallbackContextId

  const evaluate = async (expression, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const contextId = liveContextId()
      const result = await connection.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        ...(contextId !== undefined ? { contextId } : {}),
      })
      if (result.exceptionDetails !== undefined) throw new Error(`evaluating '${expression}' threw: ${result.exceptionDetails.text}`)
      /**
       * A successful reply is `{ id, result: { result: { type, value } } }` — one nesting level deeper
       * than it reads, because the protocol's result object and the remote object inside it share the
       * name. Reading `message.result.value` gives `undefined` for every expression that *succeeds*.
       */
      const remote = result.result?.result
      if (remote !== undefined || Date.now() > deadline) return remote?.value
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
    }
  }

  return {
    /**
     * The DevTools connection itself, for the one thing the options do not cover.
     *
     * Handed out deliberately rather than wrapped: a narrow wrapper would have to be extended for every emulation a
     * check wants, while the protocol is documented and this is a check helper. `--force-light-mode` and
     * `--force-dark-mode` cover the appearance; a media feature is emulated through this.
     */
    send: (method, params) => connection.send(method, params),
    async goto(url, timeoutMs = 20_000) {
      contexts.clear()
      fallbackContextId = undefined
      mainFrameId = undefined
      const loaded = connection.once('Page.loadEventFired', timeoutMs)
      await connection.send('Page.navigate', { url })
      await loaded
      const deadline = Date.now() + timeoutMs
      while (liveContextId() === undefined && Date.now() < deadline) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
      return this
    },
    evaluate,
    async waitFor(expression, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        try {
          if (await evaluate(expression, 2_000)) return true
        } catch {
          // the page may be mid-navigation
        }
        if (Date.now() > deadline) return false
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
      }
    },
    async screenshot(path) {
      const result = await connection.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
      writeFileSync(path, Buffer.from(result.result.data, 'base64'))
      return path
    },
    close() {
      connection.close()
      child.kill('SIGKILL')
      // Chrome keeps writing its profile while it exits, so a single rm loses the race (ENOTEMPTY).
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          rmSync(profile, { recursive: true, force: true })
          return
        } catch {
          // retry
        }
      }
    },
  }
}
