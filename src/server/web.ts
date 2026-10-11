import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { runTurn } from '../agent/loop.ts'
import { projectLedger, projectTimeline } from './ledger.ts'
import { expandHome } from '../config/schema.ts'
import { canonicalPath } from '../paths.ts'
import { readFileText, tree } from '../session/tree.ts'
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
  /** What the request actually offered, so a refusal can say which it was. */
  const offered = { cookie: credentials.cookie !== null, token: credentials.query !== null }

  /**
   * A cross-site request is refused **when it would change state and is not authenticated**.
   *
   * Both halves matter. Refusing every cross-site write broke a sandboxed viewer, whose requests are all
   * marked cross-site — measured, and it made the page's own composer answer `403`. Allowing every one would
   * drop the fence's only remaining job. Keying on the credential keeps the protection and removes the
   * breakage, because the credential cannot travel cross-site: the cookie is `SameSite=Strict`, so a browser
   * never attaches it to an attacker's request, and `decision.ok` is false exactly when it did not.
   */
  const method = String(request.method ?? 'GET').toUpperCase()
  const changesState = method !== 'GET' && method !== 'HEAD'
  if (changesState && offered.cookie && !decision.ok) {
    respond(
      response,
      403,
      'text/plain',
      'refused: a cross-site request that changes state and carries no valid session; a cross-site request may read, but writing requires the cookie this page was opened with\n',
    )
    return
  }

  /**
   * The page is served to a **session**, and refused with an explanation otherwise.
   *
   * The first version served the app shell to anyone who asked for `/`, on the reasoning that the page
   * carries no data and has a token form in it. Measured, that failed open in a way a person notices:
   * `http://127.0.0.1:3082/` with no cookie answered `200` with the whole UI — session list, prompt box and
   * an empty log — so it looked like a working page that had lost its data, rather than like a page that had
   * not been opened with a token. DSH refuses the bare URL with `401`, and this now does too.
   *
   * The cookie is the same credential the launch token mints, so a browser that has been through the printed
   * URL keeps working: the bare URL is served whenever the cookie matches, and refused when it does not.
   */
  if (url.pathname === '/' && request.method === 'GET') {
    const access = pageAccess(decision, offered)
    if (access.status === 200) {
      respond(response, 200, 'text/html; charset=utf-8', page())
      return
    }
    respond(response, access.status, 'text/html; charset=utf-8', tokenFormPage({ stale: access.stale }))
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
   * One level of the folder tree the left column draws.
   *
   * `GET /api/tree` lists the registered roots; `GET /api/tree?path=<absolute>` lists the folders
   * directly inside one of them. One level, never a whole walk: the page asks for a node's children
   * when a person opens it, which is what keeps a large target folder cheap to show.
   *
   * A path outside every root is refused with `400` rather than walked, for the same reason the CLI
   * refuses it: this route sits behind the token and must not become a directory browser for the
   * whole machine.
   */
  if (url.pathname === '/api/tree' && request.method === 'GET') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const wanted = url.searchParams.get('path')
    if (wanted !== null && wanted.length > 0 && workspaces.owner(wanted) === undefined) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: `${canonicalPath(wanted)} is not under any workspace root` })}\n`)
      return
    }
    const node = tree(wanted === null || wanted.length === 0 ? null : wanted, {
      roots: workspaces.list().map((record) => ({ path: record.path, title: record.title, ...(record.origin !== undefined ? { origin: record.origin } : {}) })),
      sessions: ctx.session.list(),
      generated: workspaces.generated,
    })
    respond(response, 200, 'application/json', `${JSON.stringify(node, null, 2)}\n`)
    return
  }

  /**
   * The content of one file, for the panel a file row opens.
   *
   * Refused outside every root, exactly as the tree is and for the same reason — this route is behind
   * the token and must not be a way to read the whole machine — and the path that is checked is the
   * **canonical** one, so a symlink that resolves outside a root is refused rather than followed. What
   * cannot be shown is a status rather than an empty panel: `404` for a path that is not a file, and
   * `415` for a file that is not UTF-8 text, each with the sentence the reader produced.
   */
  if (url.pathname === '/api/file' && request.method === 'GET') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const wanted = url.searchParams.get('path')
    if (wanted === null || wanted.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a path is required' })}\n`)
      return
    }
    if (workspaces.owner(wanted) === undefined) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: `${canonicalPath(wanted)} is not under any workspace root` })}\n`)
      return
    }
    try {
      respond(response, 200, 'application/json', `${JSON.stringify(readFileText(wanted), null, 2)}\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = message.includes('is not a file') ? 404 : 415
      respond(response, status, 'application/json', `${JSON.stringify({ error: message })}\n`)
    }
    return
  }

  /**
   * Register a folder as a workspace root, or unregister one.
   *
   * These are the two buttons the left column offers, and both go through the same record the CLI
   * writes: a folder is registered by path (the name defaults to the folder's own name), and a root
   * is unregistered by id. Registration is idempotent — registering an already-registered folder
   * reports `created: false` rather than failing — and registering a folder that was **adopted**
   * because a session ran in it promotes it into the tree, which is how ad-hoc work becomes a
   * project without moving anything.
   *
   * `DELETE` refuses when the root still holds sessions that no other root could adopt, and says so:
   * `bootstrap` re-registers any folder that has sessions and no owner, so removing such a root
   * would be undone on the next run. A refusal a person can read is better than a button that lies.
   */
  if (url.pathname === '/api/workspaces' && request.method === 'POST') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const path = typeof body.path === 'string' ? body.path.trim() : ''
    if (path.length === 0) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a path is required' })}\n`)
      return
    }
    if (!path.startsWith('/') && !path.startsWith('~')) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'the path must be absolute' })}\n`)
      return
    }
    let stat
    try {
      stat = statSync(expandHome(path))
    } catch {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: `${path} does not exist` })}\n`)
      return
    }
    if (!stat.isDirectory()) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: `${path} is not a folder` })}\n`)
      return
    }
    const name = typeof body.name === 'string' && body.name.trim().length > 0 ? body.name.trim() : undefined
    if (name !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'a name must be lowercase letters, digits and dashes' })}\n`)
      return
    }
    const { record, created } = workspaces.add(path, name)
    respond(response, 200, 'application/json', `${JSON.stringify({ record, created }, null, 2)}\n`)
    return
  }
  if (url.pathname.startsWith('/api/workspaces/') && request.method === 'DELETE') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const id = decodeURIComponent(url.pathname.slice('/api/workspaces/'.length))
    if (workspaces.find(id) === undefined) {
      respond(response, 404, 'application/json', `${JSON.stringify({ error: `no workspace ${id}` })}\n`)
      return
    }
    try {
      const outcome = workspaces.remove(id, { all: ctx.session.list() })
      respond(response, 200, 'application/json', `${JSON.stringify(outcome, null, 2)}\n`)
    } catch (error) {
      respond(response, 409, 'application/json', `${JSON.stringify({ error: (error as Error).message })}\n`)
    }
    return
  }

  /**
   * The session a folder is bound to, created when it has none.
   *
   * This is the click that opens a folder: the client asks, the server answers with the folder's
   * current session, and the transcript is then read through the existing `/api/sessions/<id>`
   * route. It is a `POST` because it may create, and it is idempotent — asking twice for one folder
   * answers with one session, which is the whole of "one folder, one session".
   */
  if (url.pathname === '/api/folders/session' && request.method === 'POST') {
    const workspaces = ctx.workspace
    if (workspaces === undefined) {
      respond(response, 503, 'application/json', `${JSON.stringify({ error: 'this profile does not load the workspace plugin' })}\n`)
      return
    }
    const body = await readJson(request, response)
    if (body === null) return
    const folder = typeof body.folder === 'string' && body.folder.length > 0 ? canonicalPath(body.folder) : ''
    if (folder === '' || workspaces.owner(folder) === undefined) {
      respond(response, 400, 'application/json', `${JSON.stringify({ error: 'the folder must be under a workspace root' })}\n`)
      return
    }
    const handle = ctx.session.openAt(folder, body.new === true ? { fresh: true } : {})
    const meta = ctx.session.list().find((entry) => entry.id === handle.id)
    respond(
      response,
      200,
      'application/json',
      `${JSON.stringify({ folder, session: { id: handle.id, turns: meta?.turns ?? 0, ...(meta?.title !== undefined ? { title: meta.title } : {}) } }, null, 2)}\n`,
    )
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
    /**
     * One route, two views of one record — which is the point of the query parameter rather than a second
     * route: the Chat view and the Trajectory view must not be able to disagree about a session, and the way
     * that happens is for both to be projections of the same events read once.
     */
    const events = ctx.session.events(handle)
    if (url.searchParams.get('view') === 'ledger') {
      /**
       * The ledger and its timeline come from one projection of one read, so the axis above the ledger cannot
       * disagree with the rows beneath it about when anything happened.
       */
      const ledger = projectLedger(events)
      respond(response, 200, 'application/json', `${JSON.stringify({ id, ledger, timeline: projectTimeline(ledger) }, null, 2)}\n`)
      return
    }
    respond(response, 200, 'application/json', `${JSON.stringify({ id, turns: transcriptTurns(events) }, null, 2)}\n`)
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
   * `Sec-Fetch-Site` is **not** judged here, and that is a correction with a reason.
   *
   * Whether a cross-site request may write depends on whether it is **already authenticated**, and this
   * function has no access to the credential. Measured: a viewer that embeds the page in a **sandboxed
   * iframe** has an opaque origin, so the browser marks every request it makes cross-site — reads worked and
   * sending a prompt was refused with `403`, because the write path judged the header on its own. The owner
   * could watch heddle in the sidebar and not talk to it.
   *
   * The rule now lives where the credential is known, and it reads: a cross-site write is refused unless it
   * carries a valid session. That is the safe half of both previous behaviours — an attacker issuing a
   * cross-site POST cannot carry the session, because the cookie is `SameSite=Strict` and a browser does not
   * attach it, so they are refused for the older and better reason: they are unauthenticated.
   *
   */
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

/**
 * Read a JSON body, answering `413` or `400` itself.
 *
 * Returns `null` when it has already replied, so a caller cannot answer twice for one request — the
 * failure mode of a helper that both reports and returns is a second response written onto a socket
 * that is already finished.
 */
async function readJson(request: IncomingMessage, response: ServerResponse): Promise<Record<string, unknown> | null> {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 10 * 1024 * 1024) {
      respond(response, 413, 'text/plain', 'request too large\n')
      return null
    }
  }
  try {
    return JSON.parse(raw.length === 0 ? '{}' : raw) as Record<string, unknown>
  } catch {
    respond(response, 400, 'text/plain', 'the body must be JSON\n')
    return null
  }
}

/** Run one turn and stream its session events back as they are written. */async function handleTurn(ctx: Context, request: IncomingMessage, response: ServerResponse, state: RequestState): Promise<void> {
  let raw = ''
  for await (const chunk of request) {
    raw += chunk
    if (raw.length > 10 * 1024 * 1024) {
      respond(response, 413, 'text/plain', 'request too large\n')
      return
    }
  }
  let body: { session?: string; prompt?: string; endpoint?: string; model?: string; folder?: string; new?: boolean }
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

  /**
   * Where the turn runs, and which session it continues.
   *
   * With no `folder` the behaviour is exactly what it was: a fresh session in the server's own
   * working directory. Naming a folder is what the tree's client asks for when a person selects a
   * node, and it continues that folder's session — which is what makes a selection in the left
   * column mean "this folder's conversation" rather than "a new one". `new` starts another one for
   * that folder instead, leaving the previous log where it is.
   */
  const folder = typeof body.folder === 'string' && body.folder.length > 0 ? canonicalPath(body.folder) : null
  const handle: SessionHandle =
    typeof body.session === 'string' && body.session.length > 0
      ? ctx.session.start({ resume: body.session })
      : folder !== null
        ? ctx.session.openAt(folder, { ...(body.new === true ? { fresh: true } : {}), title: body.prompt.slice(0, 60) })
        : ctx.session.start({ cwd: process.cwd(), title: body.prompt.slice(0, 60) })
  if (folder !== null) ctx.workspace?.ensureOwner(folder)
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
  /**
   * Any logged event, not only the two this fold looks at.
   *
   * A real transcript is a log: `session/created` carries a `cwd`, `model/request` carries a message
   * count, and the fold's job is to ignore what it does not display rather than to demand that a
   * caller pre-filter the log into a shape this file invented. Measured while a unit test handed it
   * the events a session actually holds: the narrower parameter rejected every one of them.
   */
  events: readonly { readonly type: string; readonly [key: string]: unknown }[],
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
/**
 * What a request for the page is answered with.
 *
 * A pure decision, so the rule can be judged without a server: the page needs a session, and a refusal says
 * which of the two situations the caller is in. The first version of this route served the page to anyone —
 * measured, the bare URL returned `200` and a whole UI with an empty log, which reads as a broken page
 * rather than as an unopened one.
 */
export function pageAccess(decision: { readonly ok: boolean }, offered: { readonly cookie: boolean }): { readonly status: number; readonly stale: boolean } {
  if (decision.ok) return { status: 200, stale: false }
  return { status: 401, stale: offered.cookie }
}

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
