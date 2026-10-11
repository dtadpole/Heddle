import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'

import { CONTEXT_WINDOW_EXCEEDED, ModelError } from './types.ts'

/**
 * The patterns a provider uses for "the request did not fit", checked case-insensitively.
 *
 * Adapters disagree about how to say it — OpenAI says `context_length_exceeded`, DeepSeek says the
 * conversation is too long, a gateway may just echo "maximum context length" — so the matching
 * happens once, on the body of a failed response, and everything above reads the code.
 */
const WINDOW_PATTERNS = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /context window/i,
  /too many tokens/i,
  /reduce the length of the messages/i,
  /exceeds the (?:model'?s )?(?:maximum )?context/i,
]

/** The error code one failed response deserves, given its status and body. */
export function failureCode(status: number, body: string): string {
  if (status === 400 || status === 413 || status === 422) {
    if (WINDOW_PATTERNS.some((pattern) => pattern.test(body))) return CONTEXT_WINDOW_EXCEEDED
  }
  return 'HTTP'
}

/**
 * The wire, on `node:http` rather than `fetch`.
 *
 * This is not a preference. Measured while building this: Node's `fetch` (undici)
 * owns its own `Content-Length` and emits it in its own casing, and the local
 * signing proxy this machine uses to reach its LLM gateway forwards a **duplicate**
 * `Content-Length` when the caller's copy is not in Title-Case — which Cloudflare's
 * edge answers with a bare `400 Bad Request`. Driving `node:http` directly is what
 * lets this file decide the exact header set, so the workaround lives in one place
 * and the adapters above it stay plain.
 *
 * Everything here is one shape: send a JSON body, then hand back either parsed JSON
 * or a byte stream. That covers Chat Completions, Responses and every other route
 * the harness talks to.
 */

/** One response, either buffered as JSON or streamed as bytes. */
export type WireResponse = { json: unknown } | { stream: AsyncIterable<Uint8Array>; status: number }

/** What a call needs to say. */
export interface WireRequest {
  readonly url: string
  readonly method?: 'POST' | 'GET'
  readonly body?: unknown
  readonly headers?: Record<string, string>
  readonly apiKey?: string
  readonly stream?: boolean
  readonly timeoutMs?: number
  readonly endpoint: string
  readonly signal?: AbortSignal
}

/**
 * Header names in Title-Case.
 *
 * See the file comment: this is the difference between `200` and `400` through the
 * local signing proxy. Header names are case-insensitive, so no correct server can
 * tell the difference.
 */
export function titleCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const titled = name.replace(/(^|-)([a-z])/g, (_match, boundary: string, letter: string) => `${boundary}${letter.toUpperCase()}`)
    normalized[titled] = value
  }
  return normalized
}

function isHttps(url: string): boolean {
  return new URL(url).protocol === 'https:'
}

/** Send one request and resolve with its response, buffered or streamed. */
export async function wire(request: WireRequest): Promise<WireResponse> {
  const target = new URL(request.url)
  const body = request.body === undefined ? undefined : Buffer.from(JSON.stringify(request.body), 'utf8')
  const streaming = request.stream === true

  const headers = titleCaseHeaders({
    'content-type': 'application/json',
    accept: streaming ? 'text/event-stream' : 'application/json',
    // Measured: Cloudflare's browser-integrity check answers 403 to a request
    // whose user agent is absent or obviously synthetic, even with a valid
    // service token. A plain product token is enough.
    'user-agent': 'heddle/0.0.1',
    ...(request.headers ?? {}),
  })
  if (request.apiKey) headers.Authorization = `Bearer ${request.apiKey}`
  if (body !== undefined) headers['Content-Length'] = String(body.byteLength)

  const timeoutMs = request.timeoutMs ?? 120_000

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const send = isHttps(request.url) ? httpsRequest : httpRequest
    const clientRequest = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: request.method ?? 'POST',
        headers,
      },
      resolve,
    )
    clientRequest.setTimeout(timeoutMs, () => {
      clientRequest.destroy(new Error(`timed out after ${timeoutMs}ms`))
    })
    clientRequest.on('error', (error) => {
      reject(
        new ModelError(`the request to '${request.endpoint}' could not be sent — ${error.message}`, {
          endpoint: request.endpoint,
          code: /timed out/.test(error.message) ? 'TIMEOUT' : 'TRANSPORT',
          cause: error,
        }),
      )
    })
    if (request.signal) {
      request.signal.addEventListener('abort', () => clientRequest.destroy(new Error('aborted')), { once: true })
    }
    if (body !== undefined) clientRequest.write(body)
    clientRequest.end()
  })

  const status = response.statusCode ?? 0
  if (status < 200 || status >= 300) {
    const text = await readAll(response)
    throw new ModelError(
      `'${request.endpoint}' answered ${status}${text ? ` — ${text.slice(0, 400)}` : ''}`,
      { endpoint: request.endpoint, code: failureCode(status, text), status },
    )
  }

  /**
   * What the answer **is** decides how it is read, not what was asked for.
   *
   * Measured: a provider (or a local double standing in for one) may answer an
   * event-stream request with one JSON body, or answer a JSON request with an event
   * stream. Trusting the request produced "answered with a body that is not JSON —
   * Unexpected token 'd', \"data: {\"", which is a crash where a parse was needed. The
   * content type is the only thing that actually says.
   */
  const contentType = String(response.headers['content-type'] ?? '')
  const looksStreamed = contentType.includes('text/event-stream')

  if (!streaming && !looksStreamed) {
    const text = await readAll(response)
    try {
      return { json: text.length === 0 ? null : JSON.parse(text) }
    } catch (error) {
      throw new ModelError(`'${request.endpoint}' answered with a body that is not JSON — ${(error as Error).message}`, {
        endpoint: request.endpoint,
        code: 'BAD_BODY',
      })
    }
  }

  return { stream: iterate(response), status }
}

/** Read a whole response body as text. */
function readAll(response: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => chunks.push(chunk))
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    response.on('error', reject)
  })
}

/** Relay a response body as bytes, so a caller can parse it incrementally. */
async function* iterate(response: IncomingMessage): AsyncIterable<Uint8Array> {
  for await (const chunk of response) {
    yield chunk as Uint8Array
  }
}
