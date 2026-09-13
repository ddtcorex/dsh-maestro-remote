import { describe, it, expect } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createRemoteProxy, PIN_COOKIE, LAN_PIN_COOKIE } from '../src/host/remote-proxy.ts'

/** Upstream stub: any request reaching it proves the PIN gate let the request through. */
function upstreamServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

const PUBLIC_PIN = '11112222'
const LAN_PIN = '33334444'
const TUNNEL_HOST = 'dsh.example.com'
const LAN_HOST = '192.168.1.10:3080'

async function withProxy(
  opts: { lanPin?: string | undefined; trustLoopback?: boolean },
  body: (port: number) => Promise<void>,
): Promise<void> {
  const upstream = await upstreamServer()
  const proxy = await createRemoteProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstream.port },
    ...(opts.trustLoopback === undefined ? {} : { trustLoopback: opts.trustLoopback }),
    auth: {
      isPublic: (host) => host === TUNNEL_HOST,
      getPin: async () => PUBLIC_PIN,
      ...(opts.lanPin === undefined ? {} : { getLanPin: async () => opts.lanPin as string }),
    },
  })
  try {
    await body(proxy.port)
  } finally {
    await proxy.close()
    upstream.server.close()
  }
}

/**
 * `fetch()` cannot send a custom Host header — it is a forbidden header name in
 * the Fetch spec and is silently dropped, so the proxy would see 127.0.0.1 and
 * every host class would collapse into the loopback one. These tests need real
 * host classes, so they drive the proxy with node:http directly.
 */
function request(
  port: number,
  opts: { host: string; method?: string; path?: string; cookie?: string; body?: string },
): Promise<{ status: number; setCookie: string; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host }
    if (opts.cookie !== undefined) headers.cookie = opts.cookie
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      headers['content-length'] = String(Buffer.byteLength(opts.body))
    }
    const req = httpRequest(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, setCookie: String(res.headers['set-cookie'] ?? ''), body }))
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

async function login(port: number, host: string, pin: string): Promise<{ status: number; cookie: string }> {
  const res = await request(port, { host, method: 'POST', path: '/maestro-login', body: `pin=${pin}` })
  return { status: res.status, cookie: res.setCookie }
}

async function get(port: number, host: string, cookie?: string): Promise<{ status: number; body: string }> {
  const res = await request(port, { host, ...(cookie === undefined ? {} : { cookie }) })
  return { status: res.status, body: res.body }
}

describe('LAN PIN gate (two PINs, one per host class)', () => {
  it('logs in the LAN host with the LAN PIN and issues the LAN cookie', async () => {
    await withProxy({ lanPin: LAN_PIN }, async (port) => {
      const { status, cookie } = await login(port, LAN_HOST, LAN_PIN)
      expect(status).toBe(302)
      expect(cookie).toContain(`${LAN_PIN_COOKIE}=${LAN_PIN}`)
      // The LAN cookie must satisfy the gate on the LAN host class.
      const after = await get(port, LAN_HOST, `${LAN_PIN_COOKIE}=${LAN_PIN}`)
      expect(after.status).toBe(200)
      expect(after.body).toBe('ok')
    })
  })

  it('rejects the public PIN on the LAN host (the two gates are distinct)', async () => {
    await withProxy({ lanPin: LAN_PIN }, async (port) => {
      const { status, cookie } = await login(port, LAN_HOST, PUBLIC_PIN)
      expect(status).toBe(200) // login page again
      expect(cookie).toBe('')
      expect((await get(port, LAN_HOST)).body).toContain('maestro-login-card')
    })
  })

  it('keeps the public host class on the public cookie only', async () => {
    await withProxy({ lanPin: LAN_PIN }, async (port) => {
      const { status, cookie } = await login(port, TUNNEL_HOST, PUBLIC_PIN)
      expect(status).toBe(302)
      expect(cookie).toContain(`${PIN_COOKIE}=${PUBLIC_PIN}`)
      expect(cookie).not.toContain(LAN_PIN_COOKIE)
      expect((await get(port, TUNNEL_HOST, `${PIN_COOKIE}=${PUBLIC_PIN}`)).body).toBe('ok')
      // A LAN cookie must not open the public host.
      expect((await get(port, TUNNEL_HOST, `${LAN_PIN_COOKIE}=${LAN_PIN}`)).body).toContain('maestro-login-card')
      // And the public PIN is not accepted on the public host as a LAN credential.
      expect((await login(port, TUNNEL_HOST, LAN_PIN)).cookie).toBe('')
    })
  })

  it('lets one browser hold both sessions at once', async () => {
    await withProxy({ lanPin: LAN_PIN }, async (port) => {
      const both = `${PIN_COOKIE}=${PUBLIC_PIN}; ${LAN_PIN_COOKIE}=${LAN_PIN}`
      expect((await get(port, TUNNEL_HOST, both)).body).toBe('ok')
      expect((await get(port, LAN_HOST, both)).body).toBe('ok')
    })
  })

  it('skips the gate for the local machine on a listener that trusts loopback', async () => {
    // The LAN listener is the owner's own entry; a browser on this machine must
    // not have to know the LAN PIN. The public ingress must NEVER set this flag:
    // cloudflared runs here, so every tunnelled request is loopback too.
    await withProxy({ lanPin: LAN_PIN, trustLoopback: true }, async (port) => {
      const local = await get(port, LAN_HOST)
      expect(local.status).toBe(200)
      expect(local.body).toBe('ok')
    })
  })

  it('keeps gating loopback on a listener that does not trust it (the public ingress)', async () => {
    await withProxy({ lanPin: LAN_PIN }, async (port) => {
      const local = await get(port, LAN_HOST)
      expect(local.body).toContain('maestro-login-card')
    })
  })

  it('leaves the LAN host open when no LAN PIN is configured (backward compatible)', async () => {
    await withProxy({ lanPin: undefined }, async (port) => {
      expect((await get(port, LAN_HOST)).body).toBe('ok')
    })
  })

  it('does not mint a cookie for a LAN host when the LAN gate is open', async () => {
    await withProxy({ lanPin: undefined }, async (port) => {
      const { status } = await login(port, LAN_HOST, PUBLIC_PIN)
      expect(status).toBe(302) // nothing to authenticate — straight through
      expect((await get(port, LAN_HOST)).body).toBe('ok')
    })
  })
})
