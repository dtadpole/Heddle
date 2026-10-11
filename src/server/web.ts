import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

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

  /**
   * One session's history, in the same shape the live stream delivers.
   *
   * There was no such route, and the gap was visible as a **blank right side**: the page's log region is
   * fed only by the `EventSource`, so clicking a session set the id it would filter on and then had
   * nothing to show — every event of that session had already happened. Measured in a browser: 32
   * sessions listed, `#log` empty after a click. A transcript view that only works for turns you watch
   * live is not a transcript view.
   *
   * The fold is deliberately the same vocabulary as the live path — `user`, `assistant`, `reasoning`,
   * `tool`, `denied` — so the client renders history and live deltas with one function instead of two
   * that drift.
   *
   * The deltas are read, **not** `assistant/completed`: the log records both for one turn, so reading the
   * completed event as well would print every answer twice.
   */
  if (url.pathname.startsWith('/api/sessions/') && request.method === 'GET') {
    const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length))
    /**
     * The id is a directory name under the session root, so a traversal attempt must not reach the store.
     * A real id is `session-<uuid>`; anything else is refused here rather than being resolved.
     */
    if (!/^session-[0-9a-f-]{36}$/i.test(id)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'not a session id' })}\n`)
      return
    }
    const handle = ctx.session.store.open(id)
    if (handle === null) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no session ${id}` })}\n`)
      return
    }
    respond(response, 200, 'application/json', `${JSON.stringify({ id, turns: transcriptTurns(ctx.session.events(handle)) }, null, 2)}\n`)
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

  /**
   * A cross-site request may **read**, and may not change anything.
   *
   * The first version refused every cross-site request, and that broke a legitimate consumer: a viewer that
   * embeds the page in a **sandboxed iframe** has an opaque origin, so the browser marks its requests
   * cross-site — measured, `allow-same-origin` renders the page and a fully sandboxed frame gets
   * `refused: a cross-site request`. heddle's own Web UI was unreachable from the very sidebar it is meant
   * to be watched in.
   *
   * Reads are safe to allow because the credential cannot travel: the session cookie is `SameSite=Strict`,
   * so a browser does not attach it to a cross-site request, and an attacker who issues one receives the
   * token form rather than a session. A state-changing request is a different matter — it is refused unless
   * it names this authority in `Origin`, which is checked below.
   */
  const site = String(request.headers['sec-fetch-site'] ?? '')
  const method = String(request.method ?? 'GET').toUpperCase()
  const changesState = method !== 'GET' && method !== 'HEAD'
  if (site === 'cross-site' && changesState) {
    /**
     * The message says what the rule is, because the reader is usually the author of a viewer that embeds
     * the page: a cross-site request may read and may not change anything.
     */
    return 'refused: a cross-site request that changes state; a cross-site request may read, but writes must come from this origin'
  }

  const origin = request.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      /**
       * `null` is what a sandboxed frame and a `file://` page send, and it matches no authority — so a
       * state-changing request from an opaque origin is refused here even though its read requests are
       * allowed. This check is what carries the weight once cross-site reads are permitted.
       */
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
 * Fold a session's recorded events into the display turns the page renders.
 *
 * Exported so the fold can be judged directly: it is pure, it is where the two subtle rules live (read the
 * deltas rather than the completion; keep reasoning separate), and a unit test can cover both in a way no
 * end-to-end check can isolate.
 *
 * Read from the deltas rather than from `assistant/completed`, because one turn records both and reading
 * the completion too would double every answer. Reasoning keeps its own kind, as it does live: it is the
 * part a reader most wants separated from what the model said.
 */
export function transcriptTurns(
  events: readonly { readonly type: string; readonly message?: unknown; readonly chunk?: unknown }[],
): readonly { readonly kind: string; readonly text: string; readonly label?: string }[] {
  const turns: { kind: string; text: string; label?: string }[] = []
  for (const event of events) {
    if (event.type === 'message') {
      const message = event.message as { role?: string; content?: readonly { type?: string; text?: string }[]; toolCallId?: string } | undefined
      if (message === undefined) continue
      const text = (message.content ?? []).map((part) => part.text ?? '').join('')
      if (message.role === 'user') turns.push({ kind: 'user', text })
      else if (message.role === 'tool') turns.push({ kind: /^error/i.test(text) ? 'denied' : 'tool', text })
      else if (message.role === 'assistant') turns.push({ kind: 'assistant', text })
      continue
    }
    if (event.type !== 'assistant/chunk') continue
    const chunk = event.chunk as { type?: string; text?: string; name?: string; arguments?: string } | undefined
    if (chunk === undefined) continue
    if (chunk.type === 'text-delta' && chunk.text !== undefined) turns.push({ kind: 'assistant', text: chunk.text })
    else if (chunk.type === 'reasoning-delta' && chunk.text !== undefined) turns.push({ kind: 'reasoning', text: chunk.text })
    /**
     * A tool call carries its **label** separately from its body.
     *
     * The label is what the collapsed one-liner shows — the tool's name — and the body is the arguments,
     * which are only worth reading when someone asks. Deriving the label from the text on the client would
     * mean parsing it back out of a string this code just built.
     */
    else if (chunk.type === 'tool-call' && chunk.name !== undefined) {
      turns.push({ kind: 'tool', label: `→ ${chunk.name}`, text: chunk.arguments ?? '{}' })
    }
  }
  return turns
}

/**
 * The page a refused request gets: the token form, and why it appeared when there is a reason.
 *
 * Exported for the same reason: which of the two refusals a caller sees is a decision, and it is worth
 * judging without a browser.
 *
 * One helper for every refusal, so the recovery path cannot differ between them — the stale-token case
 * was a bare sentence while the unauthenticated case had a form, and there was no reason for the two to
 * differ other than that they were written apart.
 */
export function tokenFormPage(options: { readonly stale?: boolean } = {}): string {
  /**
   * Two refusals, told apart on the page.
   *
   * "No token" and "the wrong token" are different situations and a person acts differently on each: the
   * first has never had one, the second had one that stopped working. The page says which it is, what the
   * token is, and how to read the current one — the alternative was a sentence that named neither, which
   * is what this used to be.
   */
  const reason =
    options.stale === true
      ? '<p><strong>That token is not the current one.</strong> A launch token is minted once per start, so a URL from an earlier run — a bookmark, the history, or an old log line — stops working when the server restarts.</p>'
      : '<p><strong>A launch token is required for this page.</strong> heddle prints one URL per start, with the token in it, and only that token opens this page.</p>'
  const how = `<p>Read the current one from the log, or paste it below:</p><pre>grep -o 'token=[A-Za-z0-9_-]*' ~/.heddle/web.log | tail -1</pre>`
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>heddle web</title>' +
    '<style>body{margin:0;padding:2rem;font:14px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:44rem;color-scheme:light dark}' +
    'h1{font-size:1.1rem;margin:0 0 1rem}pre{background:color-mix(in oklab,currentColor 8%,transparent);padding:.6rem .8rem;border-radius:.35rem;overflow-x:auto}' +
    'form{display:flex;gap:.5rem;margin-top:1rem}input{flex:1;padding:.5rem;font:inherit}button{padding:.5rem 1rem;font:inherit}</style>' +
    `</head><body><h1>heddle web</h1>${reason}${how}` +
    `<form method="get" action="/"><input name="${TOKEN_QUERY}" placeholder="token" autofocus><button>open</button></form>` +
    '</body></html>'
  )
}

/**
 * The page, read from the file beside this module.
 *
 * It was a template literal, and the type stripper parses the contents of one as code: an identifier-like
 * word in the markup or the CSS became a reference the compiler tried to resolve. Three separate failures
 * came from that in one edit — a `summary` element clashing with a helper's name, a bare `details` and
 * `summary` in the CSS, and an em dash reported as a module declaration. A file has none of that, needs no
 * escaping, and is what a reader can open directly.
 *
 * `build` copies it beside the compiled module, because a file the server reads at runtime is not one
 * `tsc` emits.
 */
function page(): string {
  return readFileSync(join(import.meta.dirname, 'page.html'), 'utf8')
}

/** The addresses a person could reach this server on, for a LAN-aware message. */
export function localAddresses(): readonly string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
}

export { COOKIE_MAX_AGE }
