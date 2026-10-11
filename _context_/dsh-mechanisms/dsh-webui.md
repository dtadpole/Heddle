---
title: DSH Web UI
level: L2
version: 1.0.0
description: How DSH serves its Web UI and how it protects access to it.
status: unverified
grounded_in:
  - source: the installed DSH packages under ~/.volta, read on 2026-10-11
  - source: the live store at ~/.dsh for the workspace and session shapes
---

# DSH Web UI — how it is served and how access is protected
`$P = /Users/zhenc/.volta/tools/image/packages/@deepseek-ai/dsh/lib/node_modules/@deepseek-ai/dsh` (installed
`0.1.5-rc.1`; sub-packages in `$P/node_modules/@deepseek-ai/`). CLI: `$P/lib/bin.js` → `lib/profile-boot-BP_C0vpU.js`.
## 0. Boot chain
`dsh web` is a hardcoded alias (`$P/lib/bin.js:100`, `program.command("web")…resolveBoot(web,"web",…)`),
identical to `dsh --profile web`. `runProfile()` composes `$DSH_HOME/profiles/web`; its `package.json`
`dsh.profile.bundles` = `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", …]`. Every web row lives in
`dsh-web-app/cordis.patch.yml`; flags are parsed by `dsh-web-app/lib/startup.js` (plugin `web-startup`,
providing service `webStartup`). (`dsh-authorization` = OAuth credential flows for plugins,
`dsh-anonymous-user-id` = telemetry UUID — neither is Web access control.)
## 1. HTTP server and static UI
- **Raw `node:http` `createServer`** (`dsh-host-webserver/lib/index.js:245`). No Express/Fastify.
- gzip via the `compression` middleware + `negotiator` (level 1, threshold 1024 B, `:106-130`);
  `text/event-stream` and `content-range` are never compressed (`:111-113`).
- Router = two `Map`s, exact then longest-prefix-wins (`match()`, `:322`), one fallback seat
  (`registerFallback`, `:205`) and upgrade routes (`registerUpgrade`, `:190`); unclaimed → bare `404`.
- **Static UI is a built Vite dist**, not a dev server and not embedded. `dsh-host-frontend-static`
  claims the fallback seat and serves `dirname(distIndex)`; `distIndex` comes from
  `dsh-web-app/lib/index.js:107-115` as `require.resolve("@deepseek-ai/dsh-web-frontend/package.json") + "/dist/index.html"`
  (real files under `dsh-web-frontend/dist/`: `index.html`, `assets/*`, `favicon.svg`, `manifest.webmanifest`).
- Index is re-rendered per request: `serveStatic` calls `renderIndex()` =
  `webServer.renderIndex(await readFile(distIndex))` then injects `<base href="/">`; `renderIndex`
  renders structured `webserver/index-inject` rows then raw `tapIndex` transforms
  (`dsh-host-webserver/lib/index.js:338-362`). Rows carry `window.__DSH_BOOT__` (client module graph),
  `__DSH_CONNECTION_RECOVERY__` and `<script src>` batches.
- Only the dist root and the `distIndex` path render index; every other unmatched path is a plain `404`
  — **no SPA history fallback**. Traversal outside dist → `403`; non-GET/HEAD → `405`.
- Vite exists only for `pnpm run dev:web`; `dsh-client-hmr` watches rebuilt client bundles.
## 2. Port, host, flags
`dsh-web-app/cordis.patch.yml:135-143` — the shipped defaults verbatim:
```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```
- **Default port `3080`; default host `127.0.0.1` (loopback only).**
- Schema (`dsh-host-webserver/lib/index.js:140-146`) permits only two literals:
  `host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required()`, `port: z.natural().max(65535)`.
- Flags (`dsh-web-app/lib/startup.js:22`): `--host <host>`, `--port <port>` ("pass 0 to let the OS
  pick a free one"), `--no-open`, `--trusted-host <authority...>` (repeatable); `--port` must match `/^\d+$/`.
- `--host 0.0.0.0` is refused (`startup.js:40`): `error: --host 0.0.0.0 is intentionally not supported
  yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead`.
  Any other `--host` fails the schema, so the shipped CLI binds loopback only; `0.0.0.0` needs a config
  patch, after which `resolveLanTrust` (`web-app/index.js:83-89`) adds port-less IPv4 literals to
  `trustedHosts` so the `/api` Host fence admits them.
- Effective port comes back from `server.address().port` (`:301`), so `--port 0` works.
## 3. Authentication
Both secrets live in `dsh-client-connection/lib/index.js` (`BrowserAuth`, `:344-449`).

**(a) per-process launch token — the thing in the URL.**
- `processLaunchToken(owner)` = `encodeBase64Url(randomBytes(32))` (`:240-246`), memoized in a `WeakMap`
  keyed by the root context: fresh every launch, **never persisted**.
- Query name `TOKEN_QUERY = "token"` (`:222`); `authenticatedUrl()` forces `pathname="/"`, clears
  search/hash, then `?token=<token>` (`:370-377`).
- Exchange at `GET /`: `authorizeIndex()` (`:386-425`) requires `method==="GET" && pathname==="/" &&
  tokens.length===1 && tokenMatches(...)`; success replies `303` with `cache-control: no-store`,
  `referrer-policy: no-referrer`, `location: /` and a `set-cookie`. The token therefore never survives
  in the address bar, history or referrer.
- `tokenMatches` is constant-time: length check then `timingSafeEqual(actualBytes, expectedBytes)` (`:275-279`).

**(b) persistent browser-session cookie.**
- Signing secret: 32 random bytes, base64url, stored once per Harness home under
  `credentialKey("client-connection", "browser-session")` (`AUTH_RECORD_KEY`, `:219`) in
  `$DSH_HOME/.credentials.yaml` (provider `dsh-credentials-local`, which refuses a file readable beyond
  its owner: `run "chmod 600 …"`). On this machine: `~/.dsh/.credentials.yaml`, mode `-rw-------`,
  record key `client-connection/browser-session`.
- Cookie name is **authority-bound**: `dsh-auth-<base64url(sha256(authority))>` where `authority` is the
  canonical `Host` (`cookieName`, `:280-282`). Value is `v1.<base64url(JSON)>.<base64url(HMAC-SHA256)>`
  with payload `{version:1, authority, issuedAt, expiresAt}` (`:298-320`).
- Attributes exactly (`:292-294`): `Max-Age=<s>; Path=/; Expires=<UTC>; HttpOnly; SameSite=Strict`.
  **No `Secure`** (plain HTTP on loopback), no `Domain`.
- `isAuthenticated()` (`:431-441`): Host present → cookie looked up by the authority-derived name →
  HMAC via `timingSafeEqual` → payload `authority === request authority` → `issuedAt <= now < expiresAt`,
  `expiresAt > issuedAt`, `expiresAt - issuedAt <= maxAge`. Default `cookieMaxAgeDays` = **30** (`:740`).

Exact failure responses:
| Surface | Status | Body |
|---|---|---|
| index `/` unauthenticated | `401` | `dsh web authentication required; reopen the URL printed by dsh web.\n` (`text/plain; charset=utf-8`, `no-store`; HEAD → empty), `writeUnauthorized` `:442-448` |
| `/api/*` unauthenticated | `401` | `unauthorized` (`index.js:772-776`) |
| `/api/*` Host/Origin fence failure | `403` | `forbidden` |
| `/api/remote.mux` upgrade rejected | `401`/`403` | hand-written raw HTTP `unauthorized`/`forbidden` (`rejectRemoteStreamUpgrade`, api-gateway `index.js:377-388`) |
## 4. Other protections
`isTrustedApiRequest` (`dsh-client-connection/lib/index.js:201-215`) runs on every `/api` request
*before* auth, via `requestRejection` (`:553-556`):
```js
function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, "host");         if (host === void 0) return false;
  const hostUrl = parseAuthority(host);                 if (hostUrl === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request.headers, "origin");
  if (origin === void 0) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}
requestRejection(r) { if (!isTrustedApiRequest(r, this.trustedHosts)) return 403; return this.browserAuth.isAuthenticated(r) ? void 0 : 401; }
```
- Loopback = `localhost`, `[::1]`, or any `127.0.0.0/8` (`:117-121`). The Host fence is the
  DNS-rebinding defence; Origin/`sec-fetch-site` is the cross-site defence.
- `trustedHosts` entries must be bare canonical authorities — `assertTrustedAuthority` (`:165-169`)
  rejects paths, userinfo, stray whitespace, zero-padded ports and non-canonical spellings, failing the
  plugin load loudly. A port-less entry matches any port; an explicit port matches `host:port` exactly (`:188-194`).
- **No CSRF token, no per-session key, no IP allow-list in core.** CSRF is answered by `SameSite=Strict`
  + the authority-bound cookie + the Origin/`sec-fetch-site` fence.
- **No CSP, no X-Frame-Options, no HSTS** anywhere in webserver / frontend-static / web-app (grep negative).
- Body cap `maxRequestBodyBytes` default `300 * 1024 * 1024` (`:24`) → `413` + `connection: close`, request
  destroyed; RPC body must be `application/json` → `415`; unparsable JSON → `400`.
- `/plugins/*` bundles and `/plugins/events` are registered **without** the fence or auth: public static
  asset bytes by design.
## 5. Long-lived connection
There is **no SSE for application traffic** — the stream carrier is a WebSocket.
- Route `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"` (`dsh-api-gateway` stream-protocol), registered as an
  HTTP **upgrade** route (`api-gateway/lib/index.js:459-477`); before handing the socket to `ws` it runs
  the *same* check — `webCtx.connection.requestRejection(req)` — then `rejectRemoteStreamUpgrade` on failure.
- The browser gets the cookie without effort: `remoteStreamUrl()` (api-gateway client.js `:544-550`) builds
  `new URL("/api/remote.mux", location.origin)` and flips `https:→wss:`; `new WebSocket(url)` sends `Host`,
  `Origin` and `Cookie` on the handshake. The HttpOnly cookie — not a header or query parameter — is the
  credential, which is exactly why the design uses a cookie.
- One socket multiplexes logical streams: down `{type:"open"|"cancel", streamId, endpoint, payload}`, up
  `{type:"item"|"error"|"end", streamId}`. App events ride internal endpoint `$events`; listener results
  post back over unary RPC `$events/result`.
- Liveness: ping every `websocketHeartbeatIntervalMs` (**default 2000 ms**), `MAX_MISSED_HEARTBEATS = 2`
  → `socket.terminate()` (`api-gateway/lib/index.js:197,251-268`).
- Unary RPC is `POST /api/<endpoint>` with `content-type: application/json` and envelope
  `{type:"client-request", rpcId, method, payload}`; business failures return **inside a 200 envelope**
  (`gateway/bad-request` etc.), not as an HTTP status.
- The only SSE in the tree is dev-only HMR: `GET /plugins/events` (`dsh-client-hmr/lib/index.js:5,121-155`),
  `text/event-stream`, first frame `: connected\n\n`, **unauthenticated**.
## 6. Exact URL paths and boot output
| Path | Owner | Notes |
|---|---|---|
| `/` | frontend-static fallback | authenticated index (303 exchange or cookie) |
| `/assets/*`, `/favicon.svg`, `/manifest.webmanifest` | frontend-static fallback | public |
| `/api` prefix | client-connection | unary RPC + exact fetch routes; fence + cookie |
| `/api/<endpoint>` | Typert gateway / controllers | POST JSON envelope |
| `/api/session/uploadFileBinary` | dsh-client-file-upload | exact POST, streaming body |
| `/api/remote.mux` | dsh-api-gateway | WebSocket upgrade (all streams/events) |
| `/plugins`, `/plugins/<id>/client.js[.map]`, `/plugins/??<ids>/client.js&rev=` | dsh-client-modules | public bundles |
| `/plugins/events` | dsh-client-hmr | public SSE (dev) |

Boot output (`dsh-web-app/lib/index.js:194-217`) — two lines, URL first:
```
dsh web: http://127.0.0.1:3080/?token=<base64url-32-bytes>
dsh web: opening the default browser; pass --no-open to disable
```
A ` (LAN: <url-with-token>)` suffix appears only when a LAN IPv4 literal exists (all-interface bind). The browser
handoff reuses the same authenticated URL, spawned with a scrubbed parent env (`spawnBrowserLauncher` + `scrubbedParentEnv`).
## 7. Measurables worth copying
- Launch token: 32 random bytes → base64url; per process, memory only; `timingSafeEqual`.
- Cookie secret: 32 bytes, persisted once in a mode-600 file; HMAC-SHA256; `timingSafeEqual`.
- Cookie: `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` (30 d); no `Secure`.
- Exchange: `303` + `Cache-Control: no-store` + `Referrer-Policy: no-referrer`, root path only.
- Body cap 300 MiB (`314572800`) → `413` + `connection: close`; body buffered in memory.
- WS heartbeat 2000 ms ping, terminate after 2 missed pongs, timer `unref()`ed.
- gzip level 1, threshold 1024 B, SSE/`content-range` excluded.
- Reconnect backoff: base 500 ms, factor 2, cap 10 000 ms, ready warn 3 000 ms, timeout 15 000 ms.
- Present: Host fence, Origin/`sec-fetch-site` fence, canonical `trustedHosts` validation, traversal `403`, method `405`, JSON-only `415`, per-authority cookie name.
- Absent: CSP, frame options, HSTS, CSRF token, IP allow-list, rate limiting, TLS.
## The minimum viable Web UI with token protection
Build one `node:http` server with a tiny exact/prefix router and a single fallback that serves a **prebuilt**
`dist/` from disk (read per request, no runtime bundler), renders `index.html` by string-injecting a
`window.__APP_BOOT__` global, and owns one authenticated WebSocket mux for streams. Bind port **3080** on host
**127.0.0.1**, and refuse `0.0.0.0` loudly rather than silently exposing RCE. Generate the token as
`crypto.randomBytes(32)` → base64url **per process**, keep it in memory, and print
`app: http://127.0.0.1:3080/?token=<token>`. Do not persist it, and do not put it in a header. Persist instead
a signing secret (32 random bytes, base64url) in a mode-600 file under the app home, created on first run. On
`GET /?token=…`: require exactly one token and `method === "GET"`, and compare with `crypto.timingSafeEqual`
(length check first); then reply `303` to `/` with `Set-Cookie: app-auth-<sha256(host)>=v1.<base64url(payload)>.<base64url(HMAC)>;
Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`, plus `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`. Present it thereafter as that cookie only — the WebSocket handshake sends it
automatically, which is why a cookie beats a custom header or a query token for the long-lived connection.
Check every request: `403` when `Host` is neither loopback nor an explicitly configured canonical authority, or when
`Origin`/`Sec-Fetch-Site` is cross-site; `401` when the cookie is missing, its HMAC fails, its embedded authority
differs, or it is expired. Serve the index and all `/api*` behind that check and leave hashed assets public. Add the
cheap limits with the same numbers: 10 MiB body cap → `413`, JSON-only RPC → `415`, 2 s ping / 2 missed pongs →
terminate, and `SameSite=Strict` + `HttpOnly` + Host/Origin fence in place of a CSRF token.
The whole design is one line: **unguessable per-process URL token → HMAC-signed, authority-bound, Strict cookie → Host/Origin-fenced API**.
