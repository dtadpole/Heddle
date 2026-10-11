import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The Web UI's door.
 *
 * Modelled on how DSH protects its own UI, and the shape is worth stating because
 * every part of it is deliberate:
 *
 * - **A per-process launch token** — 32 random bytes, base64url, generated when the
 *   server starts and never written anywhere. It is printed once in the URL the
 *   command outputs, and presenting it exchanges it for a cookie. DSH does exactly
 *   this, and it is why opening the UI twice in a day does not need a stored secret.
 * - **A persistent signing secret** in a mode-600 file, so a cookie survives a
 *   restart without the launch token being reusable. DSH keeps its equivalent in
 *   `$DSH_HOME/.credentials.yaml` behind its credentials provider.
 * - **A cookie bound to the authority** rather than to a user, because there is no
 *   user: `heddle-auth-<sha256(host)>` means a cookie minted for one Host cannot be
 *   replayed against another.
 * - **Constant-time comparison** for both secrets. A token compared with `===`
 *   leaks its prefix through timing, which is a real attack on a loopback service
 *   only in theory and a free fix in practice.
 *
 * The one place this departs from DSH: DSH uses a WebSocket mux, because its UI is a
 * full RPC client. This UI only streams, so a token that a browser cannot attach to
 * a WebSocket handshake would have been a problem; a `?token=` query parameter on
 * the stream endpoint solves it without a second protocol.
 */

/** How the launch token is presented, and how the session cookie is named. */
export const TOKEN_QUERY = 'token'
export const COOKIE_VERSION = 'v1'
/** Thirty days, matching the DSH default, in seconds. */
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 30

/** Where the cookie-signing secret lives. Mode 600, outside every repository. */
export function defaultSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HEDDLE_HOME ?? join(homedir(), '.heddle')
  return join(home, 'web-secret')
}

/** Expand a leading `~`, because every path in this project may be written that way. */
export function expandHome(path: string): string {
  return path.startsWith('~') ? `${homedir()}${path.slice(1)}` : path
}

/** Thirty-two random bytes, base64url — the same size and encoding DSH uses. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The launch token for one process.
 *
 * Generated per call and held only in memory by the caller, so a restart invalidates
 * every URL a previous run printed.
 */
export function createLaunchToken(): string {
  return newSecret()
}

/**
 * Read the persistent signing secret, creating it on first use.
 *
 * Written with mode 600 and then `chmod`ed again, because `writeFileSync`'s mode is
 * masked by the process umask and a secret created 0644 by a permissive umask is the
 * failure this avoids.
 */
export function readOrCreateSecret(path = defaultSecretPath()): string {
  const target = expandHome(path)
  try {
    const existing = readFileSync(target, 'utf8').trim()
    if (existing.length > 0) {
      /**
       * The mode is re-applied on every reuse, not only at creation.
       *
       * Measured: the first version set `mode: 0o600` when writing the file and never looked again,
       * so a secret copied in, restored from a backup, or created by an older version stayed at
       * whatever mode it arrived with — and a world-readable signing secret is the one failure here
       * that is silent.
       */
      try {
        chmodSync(target, 0o600)
      } catch {
        // A file we cannot chmod is still usable; the caller sees the failure through the file's
        // own permissions rather than through a crash.
      }
      return existing
    }
  } catch {
    // fall through and create it
  }
  mkdirSync(dirname(target), { recursive: true })
  const secret = newSecret()
  writeFileSync(target, `${secret}\n`, { mode: 0o600 })
  chmodSync(target, 0o600)
  return secret
}

/** The cookie's name, bound to the authority it was minted for. */
export function cookieName(authority: string): string {
  const digest = createHash('sha256').update(authority).digest('hex').slice(0, 16)
  return `heddle-auth-${digest}`
}

/**
 * Mint a cookie value for an authority.
 *
 * `v1.<issued-at>.<hmac>` — the timestamp is inside the signed payload, so an
 * expiry can be enforced without server-side state and a cookie cannot be extended
 * by editing it.
 */
export function mintCookie(secret: string, authority: string, now = Date.now()): string {
  const issued = String(now)
  const payload = `${COOKIE_VERSION}.${issued}`
  const signature = createHash('sha256').update(`${secret}:${authority}:${payload}`).digest('base64url')
  return `${payload}.${signature}`
}

/** Whether a cookie value is one this server minted, and still fresh. */
export function verifyCookie(value: string, secret: string, authority: string, maxAgeSeconds = COOKIE_MAX_AGE, now = Date.now()): boolean {
  const parts = value.split('.')
  if (parts.length !== 3) return false
  const [version, issued, signature] = parts
  if (version !== COOKIE_VERSION || issued === undefined || signature === undefined) return false
  const expected = createHash('sha256').update(`${secret}:${authority}:${version}.${issued}`).digest('base64url')
  if (!safeEqual(signature, expected)) return false
  const age = (now - Number(issued)) / 1000
  return Number.isFinite(age) && age >= 0 && age <= maxAgeSeconds
}

/**
 * Compare two strings without leaking where they differ.
 *
 * Length is compared first, because `timingSafeEqual` throws on a length mismatch and
 * a thrown error is itself a timing signal.
 */
export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** The `Set-Cookie` line for a freshly minted cookie. */
export function cookieHeader(authority: string, value: string, maxAgeSeconds = COOKIE_MAX_AGE): string {
  return `${cookieName(authority)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`
}

/** Read one cookie out of a request's `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

/** What a request presented. */
export interface Credentials {
  readonly cookie: string | null
  readonly query: string | null
}

/**
 * Whether a request may proceed, and why not when it may not.
 *
 * A request passes if either secret matches: the launch token (which the printed URL
 * carries) or the cookie (which the handshake set). Both are constant-time compared.
 */
export function authorize(
  credentials: Credentials,
  options: { readonly launchToken: string; readonly secret: string; readonly authority: string; readonly now?: number },
): { readonly ok: boolean; readonly reason?: string } {
  if (credentials.cookie !== null && verifyCookie(credentials.cookie, options.secret, options.authority, COOKIE_MAX_AGE, options.now ?? Date.now())) {
    return { ok: true }
  }
  if (credentials.query !== null && safeEqual(credentials.query, options.launchToken)) {
    return { ok: true }
  }
  return { ok: false, reason: 'authentication required' }
}
