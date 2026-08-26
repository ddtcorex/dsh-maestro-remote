import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createBrotliCompress, createGzip, constants as zlibConstants } from 'node:zlib'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { fileURLToPath } from 'node:url'
import { secretsMatch } from './secure-compare.js'

export interface ProxyUpstream { host: string; port: number }

/** Lowercased hostname of a Host header value: port stripped, trailing dot dropped; undefined when empty. */
export function normalizeHostname(host: string | undefined): string | undefined {
  if (host === undefined || host === '') return undefined
  const colon = host.indexOf(':')
  const hostname = (colon === -1 ? host : host.slice(0, colon)).trim().toLowerCase().replace(/\.$/, '')
  return hostname === '' ? undefined : hostname
}

/**
 * Whether a request Host names the public internet path: the configured named
 * tunnel hostname or any quick-tunnel `*.trycloudflare.com` host. Everything
 * else — LAN IPs, localhost spellings — is trusted-local and skips the PIN.
 */
export function isPublicHost(host: string | undefined, tunnelHostname: string | undefined): boolean {
  const normalized = normalizeHostname(host)
  if (normalized === undefined) return false
  const configured = normalizeHostname(tunnelHostname)
  if (configured !== undefined && normalized === configured) return true
  return normalized.endsWith('.trycloudflare.com')
}

export interface PinRequestFacts { headers: { cookie?: string }; url: string }

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  return out
}

/** Whether the request carries the current PIN via session cookie or `?pin=` fallback. */
export function isPinAuthorized(req: PinRequestFacts, pin: string): boolean {
  const cookiePin = parseCookies(req.headers.cookie)['maestro_pin']
  if (secretsMatch(cookiePin, pin)) return true
  return secretsMatch(new URL(req.url, 'http://x').searchParams.get('pin') ?? undefined, pin)
}

/** Rewrite browser-visible authorities to the loopback upstream so DSH's /api fence sees loopback. */
export function loopbackAuthority(headers: Record<string, string | string[] | undefined>, upstream: ProxyUpstream): void {
  const authority = `${upstream.host}:${upstream.port}`
  headers.host = authority
  if (headers.origin !== undefined) headers.origin = `http://${authority}`
}

// Copied verbatim from dsh-pocket's proven implementation rather than hand-rolled — it is
// exercised in production there.
const RANDOM_UUID_POLYFILL = `<script data-maestro-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);self.crypto.getRandomValues(b);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();</script>`
// This runs only on upstream HTML reached after handleRequest's authorization
// check. The DSH browser client consumes it before boot to enable settings for
// the authenticated proxy session without treating every public hostname as
// trusted.
const TRUSTED_PROXY_MARKER = '<script data-maestro-trusted-proxy="1">globalThis.__DSH_TRUSTED_PROXY__=true;</script>'

/** Inject the insecure-context polyfill and authenticated-proxy marker once per HTML document. */
export function injectPolyfill(html: string): string {
  let injected = html
  if (!injected.includes('data-maestro-polyfill')) injected = injected.replace(/<head[^>]*>/i, (m) => `${m}${RANDOM_UUID_POLYFILL}`)
  if (!injected.includes('data-maestro-trusted-proxy')) injected = injected.replace(/<head[^>]*>/i, (m) => `${m}${TRUSTED_PROXY_MARKER}`)
  return injected
}

/** Browser-reachable LAN URLs for the proxy port (non-internal IPv4 only). */
/** RFC1918 private ranges — the addresses phones and laptops on the same LAN can actually reach. */
const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/
/** Interface names that look like real hardware (Wi-Fi / Ethernet, Linux or Windows naming). */
const PHYSICAL_IFACE_RE = /^(?:wlan|wi-?fi|wireless|ethernet|eth\d|en\d|wlp\d)/i
/** Interface names that look like VPN or virtual adapters. */
const VPN_IFACE_RE = /(?:radmin|tailscale|zerotier|tun|tap|vpn|vethernet|virtual|vmware|virtualbox|wsl|docker|teredo|hamachi|bluetooth|bridge)/i

/**
 * Pick the LAN IPv4 a phone on the same network should open: RFC1918
 * addresses win (+100), physical-looking interface names get +20,
 * VPN/virtual names lose 50; equal scores keep enumeration order.
 * Loopback and link-local candidates are excluded; non-private addresses
 * remain as a fallback so a pure-VPN environment still gets a URL.
 */
export function selectLanIPv4(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> | (() => NodeJS.Dict<NetworkInterfaceInfo[]>) = networkInterfaces): string | null {
  const table = typeof interfaces === 'function' ? interfaces() : interfaces
  const candidates: Array<{ ip: string; score: number; order: number }> = []
  for (const [name, addresses] of Object.entries(table)) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      const ip = address.address
      if (ip === '' || ip.startsWith('127.') || ip.startsWith('169.254.')) continue
      let score = 0
      if (PRIVATE_IPV4_RE.test(ip)) score += 100
      if (PHYSICAL_IFACE_RE.test(name)) score += 20
      else if (VPN_IFACE_RE.test(name)) score -= 50
      candidates.push({ ip, score, order: candidates.length })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order)
  return candidates[0]?.ip ?? null
}

export function lanUrls(port: number, interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces): string[] {
  const best = selectLanIPv4(interfaces)
  return best === null ? [] : [`http://${best}:${port}`]
}

export interface RemoteProxyAuth {
  isPublic: (host: string | undefined) => boolean
  getPin: () => Promise<string>
  /** When present, non-public hosts are gated behind this second PIN. */
  getLanPin?: () => Promise<string>
}

export interface RemoteProxyOptions {
  port: number
  host: string
  upstream: ProxyUpstream
  auth: RemoteProxyAuth
  /**
   * Directory holding the built standalone login bundle (`login.js` / `login.css`).
   * Defaults to this package's `client/` directory; tests point it at a fixture dir.
   */
  loginAssetsDir?: string
  /**
   * Public-PIN login throttling per source address. Defaults to 5 failures per
   * 10 minutes; a fixed security default, overridable only by tests.
   */
  loginRateLimit?: LoginRateLimit
}

export interface LoginRateLimit { maxFailures: number; windowMs: number }

const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimit = { maxFailures: 5, windowMs: 10 * 60_000 }
/** Cap on tracked source addresses so the failure map cannot grow unbounded. */
const MAX_TRACKED_ADDRESSES = 1000

export interface RemoteProxyHandle {
  server: Server
  port: number
  close: () => Promise<void>
}

/** Nearest ancestor directory containing a package.json — the plugin package root from src/ (vitest) or lib/ (built). */
function packageRootDir(startFile: string): string {
  let dir = dirname(startFile)
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`remote-proxy: no package.json above ${startFile}`)
    dir = parent
  }
}

const DEFAULT_LOGIN_ASSETS_DIR = join(packageRootDir(fileURLToPath(import.meta.url)), 'client')

const LOGIN_ASSETS: Record<string, { file: string; contentType: string }> = {
  '/__maestro/login.js': { file: 'login.js', contentType: 'text/javascript; charset=utf-8' },
  '/__maestro/login.css': { file: 'login.css', contentType: 'text/css; charset=utf-8' },
}

const LOGIN_PAGE = (error: boolean) => `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Maestro access</title>
<link rel="stylesheet" href="/__maestro/login.css">
<script>window.__MAESTRO_LOGIN_ERROR__=${error ? 'true' : 'false'}</script>
</head><body><script>if(matchMedia('(prefers-color-scheme: dark)').matches)document.body.setAttribute('data-ds-dark-theme','')</script><main>
<form data-maestro-login-fallback method="post" action="/maestro-login" class="maestro-login-card${error ? ' maestro-shake' : ''}">
<p class="maestro-login-title">Maestro access</p>
<p class="maestro-login-copy${error ? ' maestro-login-error' : ''}">${error ? 'Wrong PIN, try again.' : 'This public address is PIN-protected.'}</p>
<span class="maestro-login-input maestro-login-native-input"><input id="maestro-login-token" name="token" inputmode="numeric" maxlength="8" autofocus required aria-label="Access PIN" placeholder="8-digit PIN" autocomplete="one-time-code"></span>
<button type="submit" class="maestro-login-submit">Enter</button>
</form>
<div id="maestro-login-root"></div>
</main><script src="/__maestro/login.js"></script></body></html>`

/**
 * Local reverse proxy in front of dsh web: rewrites Host/Origin to the loopback
 * upstream so DSH's /api browser-trust fence always sees loopback, gates public
 * hosts behind the rotating PIN, and injects the insecure-context
 * crypto.randomUUID polyfill into HTML documents. WebSocket upgrades pass
 * through verbatim.
 */
export function createRemoteProxy(options: RemoteProxyOptions): Promise<RemoteProxyHandle> {
  const { port, host, upstream, auth } = options
  const loginAssetsDir = options.loginAssetsDir ?? DEFAULT_LOGIN_ASSETS_DIR
  const loginRateLimit = options.loginRateLimit ?? DEFAULT_LOGIN_RATE_LIMIT
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => { void handleRequest(req, res) })

  const loginFailures = new Map<string, number[]>()

  /** Retry-after seconds while the source address is throttled, or 0 when free to try. */
  function loginThrottled(key: string): number {
    const now = Date.now()
    const recent = (loginFailures.get(key) ?? []).filter((stamp) => now - stamp < loginRateLimit.windowMs)
    loginFailures.set(key, recent)
    if (recent.length >= loginRateLimit.maxFailures) {
      return Math.ceil((loginRateLimit.windowMs - (now - recent[0])) / 1000)
    }
    return 0
  }

  function recordLoginFailure(key: string): void {
    if (!loginFailures.has(key) && loginFailures.size >= MAX_TRACKED_ADDRESSES) {
      const oldest = loginFailures.keys().next().value
      if (oldest !== undefined) loginFailures.delete(oldest)
    }
    const recent = (loginFailures.get(key) ?? []).filter((stamp) => Date.now() - stamp < loginRateLimit.windowMs)
    recent.push(Date.now())
    loginFailures.set(key, recent)
  }

  function clearLoginFailures(key: string): void {
    loginFailures.delete(key)
  }

  async function serveLoginAsset(url: string | undefined, res: ServerResponse): Promise<void> {
    const asset = url === undefined ? undefined : LOGIN_ASSETS[url.split('?')[0]]
    if (asset === undefined) {
      res.writeHead(404).end()
      return
    }
    try {
      const body = await readFile(join(loginAssetsDir, asset.file))
      res.writeHead(200, { 'content-type': asset.contentType, 'cache-control': 'no-cache' })
      res.end(body)
    } catch {
      // The bundle is a build artifact; until `pnpm run build:client` runs the
      // shell still renders and shows its static fallback text.
      res.writeHead(404).end()
    }
  }

  async function authorized(req: IncomingMessage): Promise<boolean> {
    const facts = { headers: req.headers as { cookie?: string }, url: req.url ?? '/' }
    if (auth.isPublic(req.headers.host)) return isPinAuthorized(facts, await auth.getPin())
    if (auth.getLanPin === undefined) return true
    return isPinAuthorized(facts, await auth.getLanPin())
  }

  function collectBody(req: IncomingMessage, limit = 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      let settled = false
      req.on('data', (chunk: Buffer) => {
        if (settled) return
        if (body.length + chunk.length > limit) {
          // Stop buffering and drain the socket without destroying it, so the
          // response can still be written and the request never hangs.
          settled = true
          req.resume()
          resolve(body)
          return
        }
        body += chunk.toString()
      })
      req.on('end', () => { if (!settled) { settled = true; resolve(body) } })
      req.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
    })
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remoteAddress = req.socket.remoteAddress ?? 'unknown'
    const retryAfterSeconds = loginThrottled(remoteAddress)
    if (retryAfterSeconds > 0) {
      res.writeHead(429, { 'retry-after': String(retryAfterSeconds), 'content-type': 'text/plain; charset=utf-8' })
      res.end('Too many failed PIN attempts — try again later.')
      return
    }
    const submitted = new URLSearchParams(await collectBody(req)).get('token') ?? ''
    const pin = await auth.getPin()
    if (secretsMatch(submitted, pin)) {
      clearLoginFailures(remoteAddress)
      res.writeHead(302, { location: '/', 'set-cookie': `maestro_pin=${pin}; HttpOnly; SameSite=Lax; Path=/`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    recordLoginFailure(remoteAddress)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(LOGIN_PAGE(true))
  }

  function serveLogin(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(LOGIN_PAGE(false))
  }

/** Whether the upstream response is already content-encoded (compressed streams cannot be re-compressed or text-injected). */
function isCompressed(headers: IncomingMessage['headers']): boolean {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''))
}

/** Wire the compressor between the upstream stream (with any pre-read chunks) and the client. */
function compressStream(
  upstreamRes: IncomingMessage,
  res: ServerResponse,
  useBrotli: boolean,
  buffered: Buffer[],
): true {
  const encoding = useBrotli ? 'br' : 'gzip'
  const outHeaders = { ...upstreamRes.headers }
  delete outHeaders['content-length']
  delete outHeaders['transfer-encoding']
  outHeaders['content-encoding'] = encoding
  // Caches must key compressed and identity variants separately.
  outHeaders.vary = outHeaders.vary === undefined ? 'Accept-Encoding' : `${String(outHeaders.vary)}, Accept-Encoding`
  res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
  // Brotli quality 6: near-default ratio at two orders of magnitude less CPU
  // than quality 11, which made multi-megabyte bodies time out on phones.
  const compressor = useBrotli
    ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
    : createGzip()
  for (const chunk of buffered) compressor.write(chunk)
  if (buffered.length > 0) upstreamRes.resume()
  upstreamRes.pipe(compressor)
  compressor.pipe(res)
  // Either side closing tears down all three streams. `close` on upstreamRes
  // also fires after a normal end — destroying then would cut the response
  // short — so only the client-side close and abort signals propagate.
  res.on('close', () => { upstreamRes.destroy(); compressor.destroy() })
  upstreamRes.on('error', () => { compressor.destroy(); res.destroy() })
  upstreamRes.on('aborted', () => { compressor.destroy(); res.destroy() })
  compressor.on('error', () => res.destroy())
  return true
}

/** Replay already-read chunks verbatim, then pipe the rest of the upstream untouched. */
function passThroughBuffered(upstreamRes: IncomingMessage, res: ServerResponse, buffered: Buffer[]): void {
  res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
  for (const chunk of buffered) res.write(chunk)
  upstreamRes.resume()
  upstreamRes.pipe(res)
  res.on('close', () => upstreamRes.destroy())
  upstreamRes.on('error', () => res.destroy())
}

/**
 * Stream large JSON/text responses through gzip/brotli. Long session-history
 * payloads reach multiple megabytes and saturate both the LAN leg and the
 * tunnel leg; compression shrinks them roughly 10x. Skips responses that are
 * already encoded, SSE streams (their events must arrive unbuffered), HTML
 * (handled by the polyfill-injection branch), and bodies below the 1KB floor.
 * With no content-length (chunked upstream) the floor is judged on the first
 * buffered chunks; a body that ends below the floor returns those chunks so
 * the caller can replay them verbatim.
 */
async function compressIfEligible(
  req: IncomingMessage,
  upstreamRes: IncomingMessage,
  res: ServerResponse,
): Promise<{ compressed: boolean; buffered: Buffer[] }> {
  const contentType = String(upstreamRes.headers['content-type'] ?? '')
  const acceptEncoding = String(req.headers['accept-encoding'] ?? '')
  const canGzip = /\bgzip\b/.test(acceptEncoding)
  const canBr = /\bbr\b/.test(acceptEncoding)
  const isEventStream = contentType.includes('text/event-stream')
  const knownLength = Number(upstreamRes.headers['content-length'] ?? 0)
  if (!(canGzip || canBr) || isCompressed(upstreamRes.headers) || isEventStream) return { compressed: false, buffered: [] }
  if (!(contentType.includes('application/json') || contentType.startsWith('text/'))) return { compressed: false, buffered: [] }
  if (knownLength !== 0 && knownLength < 1024) return { compressed: false, buffered: [] }
  if (knownLength !== 0) {
    compressStream(upstreamRes, res, canBr, [])
    return { compressed: true, buffered: [] }
  }
  const buffered: Buffer[] = []
  let total = 0
  const enough = await new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(giveUp)
      cleanup()
      resolve(value)
    }
    const onChunk = (chunk: Buffer): void => {
      buffered.push(chunk)
      total += chunk.length
      if (total >= 1024) settle(true)
    }
    const onEnd = (): void => { settle(false) }
    const cleanup = (): void => {
      upstreamRes.off('data', onChunk)
      upstreamRes.off('end', onEnd)
    }
    upstreamRes.on('data', onChunk)
    upstreamRes.on('end', onEnd)
    // A body that never ends (a mislabeled stream) must not wedge the client:
    // give up on compressing and let the pass-through replay what arrived.
    const giveUp = setTimeout(onEnd, 250).unref()
  })
  if (!enough) return { compressed: false, buffered }
  compressStream(upstreamRes, res, canBr, buffered)
  return { compressed: true, buffered: [] }
}

  /** Route one upstream response: HTML polyfill injection, compression, or raw pass-through. */
  async function handleUpstreamResponse(req: IncomingMessage, upstreamRes: IncomingMessage, res: ServerResponse): Promise<void> {
    const compressed = upstreamRes.headers['content-encoding'] !== undefined
    const isHtml = String(upstreamRes.headers['content-type'] ?? '').includes('text/html')
    if (isHtml && !compressed) {
      const chunks: Buffer[] = []
      upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk))
      upstreamRes.on('end', () => {
        const out = Buffer.from(injectPolyfill(Buffer.concat(chunks).toString('utf-8')), 'utf-8')
        const outHeaders = { ...upstreamRes.headers }
        delete outHeaders['content-length']
        delete outHeaders['transfer-encoding']
        outHeaders['content-length'] = String(out.length)
        res.writeHead(upstreamRes.statusCode ?? 200, outHeaders)
        res.end(out)
      })
      upstreamRes.on('error', () => res.destroy())
      return
    }
    const outcome = await compressIfEligible(req, upstreamRes, res)
    if (outcome.compressed) return
    if (outcome.buffered.length > 0) {
      passThroughBuffered(upstreamRes, res, outcome.buffered)
      return
    }
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
    upstreamRes.pipe(res)
    res.on('close', () => upstreamRes.destroy())
    upstreamRes.on('error', () => res.destroy())
  }

  function proxyRequest(req: IncomingMessage, res: ServerResponse): void {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    loopbackAuthority(headers, upstream)
    const upstreamReq = httpRequest({ host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers }, (upstreamRes) => { void handleUpstreamResponse(req, upstreamRes, res) })
    upstreamReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('remote-proxy: cannot reach dsh web — start dsh web first')
    })
    req.pipe(upstreamReq)
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      // The login route and its static assets must sit before the gate: they
      // are how an unauthenticated public visitor presents the PIN at all.
      if (req.method === 'POST' && req.url?.startsWith('/maestro-login')) {
        await handleLogin(req, res)
        return
      }
      if (req.method === 'GET' && req.url?.startsWith('/__maestro/')) {
        await serveLoginAsset(req.url, res)
        return
      }
      // Chromium fetches the PWA manifest with a CORS fetch that may omit the
      // PIN cookie even after the top-level navigation authenticated. The
      // manifest is static app metadata, so expose this one exact asset while
      // keeping every UI/API route behind the PIN gate.
      if (req.method === 'GET' && new URL(req.url ?? '/', 'http://proxy').pathname === '/manifest.webmanifest') {
        proxyRequest(req, res)
        return
      }
      if (!(await authorized(req))) {
        const wantsHtml = String(req.headers.accept ?? '').includes('text/html') || req.url === '/'
        if (wantsHtml) serveLogin(res)
        else {
          res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end('{"error":"unauthorized"}')
        }
        return
      }
      proxyRequest(req, res)
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`remote-proxy: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
  })

  server.on('upgrade', (req, socket, head) => { void handleUpgrade(req, socket as Socket, head) })

  async function handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    socket.on('error', () => socket.destroy())
    if (!(await authorized(req))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const headers: Record<string, string | string[] | undefined> = { ...req.headers }
    loopbackAuthority(headers, upstream)
    const upstreamReq = httpRequest({ host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers, agent: false })
    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = ['HTTP/1.1 101 Switching Protocols']
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined) lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      // The client's first frame may already sit in `head`; it must reach the
      // upstream inside the upgrade window or the mux protocol misses it.
      if (upstreamHead?.length > 0) socket.write(upstreamHead)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      const teardown = (): void => { upstreamSocket.destroy(); socket.destroy() }
      upstreamSocket.on('close', teardown)
      socket.on('close', teardown)
      upstreamSocket.on('error', teardown)
    })
    upstreamReq.on('response', (upstreamRes) => {
      if (upstreamRes.statusCode === 101) return
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ''}`]
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined) lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      socket.end(`${lines.join('\r\n')}\r\n\r\n`)
      upstreamRes.resume()
    })
    upstreamReq.on('error', () => socket.destroy())
    if (head.length > 0) upstreamReq.write(head)
    upstreamReq.end()
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address !== null ? address.port : port
      resolve({
        server,
        port: actualPort,
        close: () => new Promise<void>((resolveClose) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => resolveClose())
        }),
      })
    })
  })
}
