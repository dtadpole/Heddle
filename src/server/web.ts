import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'

import type { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../agent/loop.ts'
import type { SessionEvent, SessionHandle } from '../session/store.ts'
import {
  COOKIE_MAX_AGE,
  cookieHeader,
  cookieName,
  createLaunchToken,
  mintCookie,
  readCookie,
  readOrCreateSecret,
  safeEqual,
  TOKEN_QUERY,
  authorize,
} from './token.ts'

/**
 * The Web UI.
 *
 * Modelled on DSH's, with one deliberate difference and the reasons stated:
 *
 * - **`node:http`, no framework.** DSH uses raw `createServer` with a small routing
 *   table and so does this. A UI that serves one page and four endpoints does not
 *   need a router library, and a dependency here would be the largest thing in the
 *   package.
 * - **Loopback only, and it says so.** DSH refuses `0.0.0.0` because a harness that
 *   runs tools over a network is a remote code execution service. This binds
 *   `127.0.0.1` and refuses any other host with an error rather than a warning.
 * - **`?token=` on the root, then a cookie.** DSH's handshake: the printed URL carries
 *   a per-process token, the root exchange sets an HttpOnly cookie, and everything
 *   after that is the cookie. The launch token is never stored.
 * - **SSE rather than a WebSocket mux.** DSH multiplexes a full RPC client over a
 *   socket; this UI only **streams**, and a browser cannot set a header on a WebSocket
 *   handshake, so a stream that a cookie alone authenticates is the smaller mechanism.
 * - **A Host and Origin fence before authentication.** DSH's `requestRejection` runs
 *   first, and the ordering matters: a request from a page that is not this page is
 *   refused before any secret is compared.
 */

/**
 * The default port.
 *
 * **3082**, because on this machine 3080 is `dsh web` and 3081 is a Python relay that also
 * serves a DeepSeek Harness page. Measured, not assumed: 3081 was the number asked for, and
 * `lsof` showed it already held, which would have made `heddle web` fail to bind on the very
 * machine it is developed on. 3082 is the next free port in the same range and keeps the three
 * services one number apart, which is easier to remember than an arbitrary free one.
 */
export const DEFAULT_PORT = 3082
/** The default host. Anything else is refused. */
export const DEFAULT_HOST = '127.0.0.1'

export interface WebServerOptions {
  readonly host?: string
  readonly port?: number
  /** Where the cookie-signing secret lives. */
  readonly secretPath?: string
  /** The launch token; generated when absent, which is the normal case. */
  readonly token?: string
  /** Whether to print the URL line. Off in checks, on for a person. */
  readonly quiet?: boolean
  /**
   * The endpoint a turn uses when the request does not name one.
   *
   * Without this the API fell back to the first configured endpoint, so `heddle web --endpoint
   * double` started a server that answered from `scripted` — measured, and it made a check fail
   * with "the script for 'scripted' could not be read" while the server's own output said
   * `double` was configured.
   */
  readonly defaultEndpoint?: string
}

export interface WebServer {
  readonly url: string
  readonly token: string
  readonly port: number
  readonly host: string
  close(): Promise<void>
}

/** What the caller learns when the server is up, before it starts serving. */
export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1'
}

/**
 * Start the server.
 *
 * Returns once it is listening, so a caller can print the URL and open a browser
 * without racing the socket.
 */
export async function startWebServer(ctx: Context, options: WebServerOptions = {}): Promise<WebServer> {
  const host = options.host ?? DEFAULT_HOST
  if (!isLoopback(host)) {
    throw new Error(
      `refusing to bind ${host}: the Web UI runs tools, so exposing it is remote code execution behind a token. Use ${DEFAULT_HOST}.`,
    )
  }
  const port = options.port ?? DEFAULT_PORT
  const token = options.token ?? createLaunchToken()
  const secret = readOrCreateSecret(options.secretPath)

  const clients = new Set<ServerResponse>()
  const subscribers = new Set<ServerResponse>()
  // Tracked so shutdown can reach a connection whose handler is still awaiting a turn.
  const sockets = new Set<import('node:net').Socket>()

  // Every append is pushed to whoever is listening, from the one write path.
  ctx.on('session/event', (payload) => {
    const line = `event: session\ndata: ${JSON.stringify(payload)}\n\n`
    for (const client of subscribers) {
      client.write(line)
    }
  })

  const server: Server = createServer((request, response) => {
    /**
     * A request handler that throws must not take the server with it.
     *
     * `void` on a promise discards its rejection, so an error anywhere in a route became an
     * unhandled rejection and killed the process — which then made the *next* check fail with
     * "fetch failed", a message about the wrong thing entirely.
     */
    void handle(ctx, request, response, {
      token,
      secret,
      host,
      port,
      clients,
      subscribers,
      ...(options.quiet !== undefined ? { quiet: options.quiet } : {}),
      ...(options.defaultEndpoint !== undefined ? { defaultEndpoint: options.defaultEndpoint } : {}),
    }).catch((error: unknown) => {
      if (!response.writableEnded && !response.destroyed) {
        try {
          response.writeHead(500, { 'content-type': 'text/plain' })
          response.end(`internal error: ${(error as Error).message}\n`)
        } catch {
          // the socket is already gone
        }
      }
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolvePromise())
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port
  const url = `http://${host}:${boundPort}/?${TOKEN_QUERY}=${token}`

  return {
    url,
    token,
    host,
    port: boundPort,
    /**
     * Stop the server, streams and all.
     *
     * `server.close()` only stops accepting and then waits for every open connection, and an
     * event stream is open by design — so the close callback never fired while a client was
     * subscribed. Measured: that is what made the Web UI verifier run for minutes and then
     * leave `node --test` reporting "the event loop has already resolved" with a pending
     * promise. Ending the subscribers first, then destroying whatever sockets remain, is the
     * difference between closing and stopping.
     */
    close: () =>
      new Promise<void>((resolvePromise) => {
        for (const client of subscribers) {
          try {
            client.end()
          } catch {
            // the client is already gone
          }
        }
        subscribers.clear()
        server.close(() => resolvePromise())
        server.closeAllConnections?.()
        for (const socket of sockets) socket.destroy()
      }),
  }
}

interface RequestState {
  readonly token: string
  readonly secret: string
  readonly host: string
  readonly port: number
  readonly clients: Set<ServerResponse>
  readonly subscribers: Set<ServerResponse>
  readonly quiet?: boolean
  readonly defaultEndpoint?: string
}

/** One request, routed and fenced. */
async function handle(ctx: Context, request: IncomingMessage, response: ServerResponse, state: RequestState): Promise<void> {
  const authority = request.headers.host ?? `${state.host}:${state.port}`
  const url = new URL(request.url ?? '/', `http://${authority}`)

  /**
   * The fence, before any secret is compared.
   *
   * A page on another origin can make a browser send a request here; the browser
   * attaches the cookie, and without this check the response would be readable to
   * that page. `Sec-Fetch-Site` is the modern signal and `Origin` the older one, so
   * both are read and either is enough to refuse.
   */
  const fence = rejectUntrusted(request, authority)
  if (fence !== null) {
    respond(response, 403, 'text/plain', `${fence}\n`)
    return
  }

  /**
   * A liveness answer that carries no data.
   *
   * Before the handshake and before authentication, and empty of anything private: a supervisor, a
   * monitor or a person needs to know that **this** service owns the port, and two facts answer that —
   * the service's name and that nothing sensitive came back. It is what the daemon definition's liveness
   * probe asks (see `_tools_/web-daemon/`), so the definition and the server agree on one endpoint rather
   * than on parsing a banner.
   *
   * It is also the one route reachable without a token, which is why it says nothing: no sessions, no
   * counts, no version.
   */
  if (url.pathname === '/healthz' && request.method === 'GET') {
    respond(response, 200, 'application/json', `${JSON.stringify({ ok: true, service: 'heddle-web', port: state.port })}\n`)
    return
  }

  // The handshake: a valid launch token in the query becomes a cookie.
  if (url.pathname === '/' && url.searchParams.has(TOKEN_QUERY)) {
    const presented = url.searchParams.get(TOKEN_QUERY) ?? ''
    if (!safeEqual(presented, state.token)) {
      /**
       * A token that does not match gets the **page**, not a sentence.
       *
       * Measured, and it is a bug rather than a nicety: a daemon mints a fresh launch token on every
       * start, so the URL in a browser's history, in a bookmark, or in a scrollback is stale by the next
       * restart. The old answer was `401 text/plain` reading "reopen the URL printed by `heddle web`" —
       * a dead end with no form to paste the current token into and no way forward except finding the
       * log. A refusal a person cannot recover from turns a restart into an outage.
       */
      respond(response, 401, 'text/html; charset=utf-8', tokenFormPage({ stale: true }))
      return
    }
    response.writeHead(303, {
      location: '/',
      'set-cookie': cookieHeader(authority, mintCookie(state.secret, authority)),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    response.end()
    return
  }

  const credentials = {
    cookie: readCookie(request.headers.cookie, cookieName(authority)),
    query: url.searchParams.get(TOKEN_QUERY),
  }
  const decision = authorize(credentials, { launchToken: state.token, secret: state.secret, authority })

  // The page itself may be served without the cookie; it carries no data and asks for
  // the token in its own form. Everything that answers with data requires it.
  if (url.pathname === '/' && request.method === 'GET') {
    respond(response, 200, 'text/html; charset=utf-8', page())
    return
  }

  if (!decision.ok) {
    respond(
      response,
      401,
      url.pathname.startsWith('/api') ? 'text/plain' : 'text/html; charset=utf-8',
      url.pathname.startsWith('/api') ? 'unauthorized\n' : tokenFormPage(),
    )
    return
  }

  if (url.pathname === '/api/sessions' && request.method === 'GET') {
    respond(response, 200, 'application/json', `${JSON.stringify(ctx.session.list(), null, 2)}\n`)
    return
  }

  if (url.pathname === '/api/events' && request.method === 'GET') {
    respondSse(response)
    state.subscribers.add(response)
    request.on('close', () => state.subscribers.delete(response))
    return
  }

  if (url.pathname === '/api/turn' && request.method === 'POST') {
    await handleTurn(ctx, request, response, state)
    return
  }

  respond(response, 404, 'text/plain', 'not found\n')
}

/**
 * The Host and Origin fence.
 *
 * Returns a reason when the request must be refused, `null` when it may proceed.
 * Extracted so the rule is testable without a socket.
 */
export function rejectUntrusted(request: { headers: Record<string, string | string[] | undefined>; method?: string }, authority: string): string | null {
  const host = String(request.headers.host ?? '')
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (host !== '' && !isLoopback(hostname ?? '')) return `refused: Host ${host} is not loopback`

  const site = String(request.headers['sec-fetch-site'] ?? '')
  if (site === 'cross-site') return 'refused: a cross-site request'

  const origin = request.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== authority) return `refused: Origin ${origin} does not match ${authority}`
    } catch {
      return `refused: Origin ${origin} is not a URL`
    }
  }
  return null
}

/** Run one turn and stream its session events back as they are written. */
async function handleTurn(ctx: Context, request: IncomingMessage, response: ServerResponse, state: RequestState): Promise<void> {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 10 * 1024 * 1024) {
      respond(response, 413, 'text/plain', 'request too large\n')
      return
    }
  }
  let body: { session?: string; prompt?: string; endpoint?: string; model?: string }
  try {
    body = JSON.parse(raw.length === 0 ? '{}' : raw) as typeof body
  } catch {
    respond(response, 400, 'text/plain', 'the body must be JSON\n')
    return
  }
  if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
    respond(response, 400, 'text/plain', 'a prompt is required\n')
    return
  }

  const handle: SessionHandle = ctx.session.start({
    ...(typeof body.session === 'string' && body.session.length > 0 ? { resume: body.session } : {}),
    cwd: process.cwd(),
    title: body.prompt.slice(0, 60),
  })
  const endpoint = body.endpoint ?? state.defaultEndpoint ?? ctx.model.defaultEndpoint()
  if (endpoint === undefined) {
    respond(response, 400, 'text/plain', 'no endpoint is configured\n')
    return
  }
  if (!ctx.model.names().includes(endpoint)) {
    respond(response, 400, 'text/plain', `no endpoint named '${endpoint}'; configured: ${ctx.model.names().join(', ')}\n`)
    return
  }

  respondSse(response)
  state.clients.add(response)
  /**
   * Writing to a client that has gone away must not become an uncaught exception.
   *
   * Measured: when a check or a browser closed the stream mid-turn, the write raised
   * `ERR_STREAM_WRITE_AFTER_END` inside a request the server does not await, and the process
   * died — so the *next* request failed with "fetch failed" and the failure had nothing to do
   * with what it named.
   */
  const safeWrite = (text: string) => {
    if (response.writableEnded || response.destroyed) return
    try {
      response.write(text)
    } catch {
      // The client left; the session is recorded either way.
    }
  }
  const forward = (payload: { session: string; event: SessionEvent }) => {
    if (payload.session !== handle.id) return
    safeWrite(`event: session\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  // A listener registered through `ctx.on` here would need a fiber of its own, and the
  // request has none, so the turn's events are relayed by subscribing directly to the
  // same emit the server already listens on for other clients.
  const unsubscribe = subscribeSessionEvent(ctx, forward)
  try {
    const result = await runTurn(ctx, { session: handle, endpoint, prompt: body.prompt, ...(body.model !== undefined ? { model: body.model } : {}) })
    safeWrite(
      `event: done\ndata: ${JSON.stringify({ session: handle.id, text: result.text, finishReason: result.finishReason, rounds: result.rounds, denials: result.denials })}\n\n`,
    )
  } catch (error) {
    /**
     * The failure is logged as well as streamed. Measured: an error that only reached the
     * client left the server's own output silent, so diagnosing it meant guessing from an empty
     * stream instead of reading one line.
     */
    ctx.logger.warn('web: the turn failed — %s', (error as Error).message)
    safeWrite(`event: error\ndata: ${JSON.stringify({ message: (error as Error).message })}\n\n`)
  } finally {
    unsubscribe()
    state.clients.delete(response)
    if (!response.writableEnded && !response.destroyed) response.end()
  }
}

/**
 * Relay `session/event` to one function for the duration of a request.
 *
 * Cordis's `ctx.on` returns a disposer and is the normal way to listen; this wrapper
 * exists so the call site reads as what it is — a subscription with a lifetime the
 * request owns.
 */
function subscribeSessionEvent(ctx: Context, forward: (payload: { session: string; event: SessionEvent }) => void): () => void {
  const dispose = ctx.on('session/event', forward)
  return () => {
    if (typeof dispose === 'function') dispose()
  }
}

function respondSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  response.write(': heddle stream open\n\n')
}

function respond(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  response.end(body)
}

/** The page. One file, no build step, and no framework — the same choice DSH makes. */
/**
 * The page a refused request gets: the token form, and why it appeared when there is a reason.
 *
 * One helper for every refusal, so the recovery path cannot differ between them — the stale-token case
 * was a bare sentence while the unauthenticated case had a form, and there was no reason for the two to
 * differ other than that they were written apart.
 */
function tokenFormPage(options: { readonly stale?: boolean } = {}): string {
  const reason =
    options.stale === true
      ? '<p><strong>That token is not the current one.</strong> The launch token is minted once per start, so a URL from an earlier run — a bookmark, the history, or an old log line — stops working when the server restarts. Read the current one with <code>grep -o \'token=[A-Za-z0-9_-]*\' ~/.heddle/web.log | tail -1</code>, or paste it below.</p>'
      : '<p>Authentication required. Reopen the URL printed by <code>heddle web</code>, or paste the token below.</p>'
  return `<h1>heddle web</h1>${reason}<form method="get" action="/"><input name="${TOKEN_QUERY}" placeholder="token" autofocus><button>open</button></form>`
}

function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>heddle</title>
<style>
  :root { color-scheme: light dark; --line: color-mix(in oklab, currentColor 20%, transparent); }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; display: flex; height: 100vh; }
  aside { width: 22rem; border-right: 1px solid var(--line); overflow-y: auto; padding: .75rem; }
  main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  h1 { font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; opacity: .6; margin: .25rem 0 .5rem; }
  ol { list-style: none; margin: 0; padding: 0; }
  li { padding: .4rem .5rem; border-radius: .35rem; cursor: pointer; }
  li:hover { background: color-mix(in oklab, currentColor 8%, transparent); }
  li[aria-current] { background: color-mix(in oklab, currentColor 14%, transparent); }
  .meta { opacity: .6; font-size: .78rem; }
  #log { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: .6rem; }
  .turn { border-left: 3px solid var(--line); padding-left: .6rem; white-space: pre-wrap; }
  .turn.user { border-color: #4b8bf5; }
  .turn.assistant { border-color: #2fa36b; }
  .turn.reasoning { border-color: #b7791f; opacity: .85; font-style: italic; }
  .turn.tool { border-color: #8b5cf6; font-family: ui-monospace, monospace; font-size: .85em; }
  .turn.denied { border-color: #d14343; color: #d14343; }
  form { display: flex; gap: .5rem; padding: .75rem; border-top: 1px solid var(--line); }
  textarea { flex: 1; resize: vertical; min-height: 3.5rem; font: inherit; padding: .5rem; }
  button { font: inherit; padding: .5rem 1rem; }
</style>
</head>
<body>
<aside>
  <h1>Sessions</h1>
  <ol id="sessions"></ol>
</aside>
<main>
  <div id="log"></div>
  <form id="prompt">
    <textarea name="prompt" placeholder="ask heddle something" autofocus></textarea>
    <button>run</button>
  </form>
</main>
<script type="module">
const log = document.getElementById('log')
const list = document.getElementById('sessions')
let current = null

function add(kind, text) {
  if (text === '' || text === undefined) return
  const last = log.lastElementChild
  if (last && last.dataset.kind === kind) { last.textContent += text; return }
  const node = document.createElement('div')
  node.className = 'turn ' + kind
  node.dataset.kind = kind
  node.textContent = text
  log.append(node)
  log.scrollTop = log.scrollHeight
}

async function refreshSessions() {
  const response = await fetch('/api/sessions')
  if (!response.ok) return
  const sessions = await response.json()
  list.replaceChildren(...sessions.slice(0, 50).map((session) => {
    const item = document.createElement('li')
    item.innerHTML = '<div>' + (session.title ?? session.id) + '</div><div class="meta">' + session.turns + ' turn(s) · ' + session.created + '</div>'
    if (session.id === current) item.setAttribute('aria-current', 'true')
    item.onclick = () => { current = session.id; refreshSessions() }
    return item
  }))
}

const events = new EventSource('/api/events')
events.addEventListener('session', (message) => {
  const payload = JSON.parse(message.data)
  if (current && payload.session !== current) return
  const event = payload.event
  if (event.type === 'assistant/chunk' && event.chunk.type === 'text-delta') add('assistant', event.chunk.text)
  else if (event.type === 'assistant/chunk' && event.chunk.type === 'reasoning-delta') add('reasoning', event.chunk.text)
  else if (event.type === 'assistant/chunk' && event.chunk.type === 'tool-call') add('tool', '→ ' + event.chunk.name + ' ' + event.chunk.arguments)
  else if (event.type === 'message' && event.message.role === 'user') add('user', event.message.content.map((part) => part.text ?? '').join(''))
  else if (event.type === 'message' && event.message.role === 'tool') add(event.message.content.some((part) => part.text?.startsWith('error')) ? 'denied' : 'tool', event.message.content.map((part) => part.text ?? '').join(''))
})

document.getElementById('prompt').addEventListener('submit', async (submitEvent) => {
  submitEvent.preventDefault()
  const textarea = submitEvent.target.elements.prompt
  const prompt = textarea.value.trim()
  if (prompt === '') return
  textarea.value = ''
  add('user', prompt)
  const response = await fetch('/api/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, session: current }),
  })
  if (!response.ok) { add('denied', 'request refused: ' + response.status); return }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (const block of buffer.split('\\n\\n')) {
      if (!block.trim().startsWith('event:')) continue
      const name = /event: (.+)/.exec(block)?.[1]
      const data = /data: (.+)/.exec(block)?.[1]
      if (!data) continue
      const payload = JSON.parse(data)
      if (name === 'session') {
        current = payload.session
        const event = payload.event
        if (event.type === 'assistant/chunk' && event.chunk.type === 'text-delta') add('assistant', event.chunk.text)
        else if (event.type === 'assistant/chunk' && event.chunk.type === 'reasoning-delta') add('reasoning', event.chunk.text)
      } else if (name === 'done') {
        for (const denial of payload.denials ?? []) add('denied', denial.tool + ': ' + denial.message)
        refreshSessions()
      } else if (name === 'error') add('denied', payload.message)
    }
    const lastBreak = buffer.lastIndexOf('\\n\\n')
    if (lastBreak !== -1) buffer = buffer.slice(lastBreak + 2)
  }
})

refreshSessions()
</script>
</body>
</html>
`
}

/** The addresses a person could reach this server on, for a LAN-aware message. */
export function localAddresses(): readonly string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
}

export { COOKIE_MAX_AGE }
