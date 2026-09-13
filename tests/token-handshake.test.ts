import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import {
  createHandshakeGuard,
  createRemoteProxy,
  handshakeGuidancePage,
  isTokenHandshakeRedirect,
  tokenHandshakePage,
} from '../src/host/remote-proxy.ts'

describe('createHandshakeGuard', () => {
  it('allows three handshakes per identity per window and blocks the fourth', () => {
    let now = 1_000_000
    const guard = createHandshakeGuard({}, { now: () => now })
    expect(guard.check('a')).toBe(true)
    expect(guard.check('a')).toBe(true)
    expect(guard.check('a')).toBe(true)
    expect(guard.check('a')).toBe(false)
    expect(guard.check('b')).toBe(true) // its own bucket
    guard.reset('a')
    expect(guard.check('a')).toBe(true) // ?retry
  })

  it('slides the window instead of blocking forever', () => {
    let now = 1_000_000
    const guard = createHandshakeGuard({ maxHandshakes: 1, windowMs: 60_000 }, { now: () => now })
    expect(guard.check('a')).toBe(true)
    expect(guard.check('a')).toBe(false)
    now += 60_000
    expect(guard.check('a')).toBe(true)
  })
})

describe('isTokenHandshakeRedirect', () => {
  it('accepts a 3xx that carries a cookie and rejects everything else', () => {
    expect(isTokenHandshakeRedirect(303, 'dsh-auth-a=b; Path=/')).toBe(true)
    expect(isTokenHandshakeRedirect(302, ['dsh-auth-a=b', 'dsh-auth-c=d'])).toBe(true)
    expect(isTokenHandshakeRedirect(303, undefined)).toBe(false)
    expect(isTokenHandshakeRedirect(303, '   ')).toBe(false)
    expect(isTokenHandshakeRedirect(200, 'dsh-auth-a=b')).toBe(false)
    expect(isTokenHandshakeRedirect(undefined, 'dsh-auth-a=b')).toBe(false)
  })
})

describe('handshake pages', () => {
  it('serves a 200 page whose meta refresh continues to the upstream target', () => {
    const page = tokenHandshakePage('/')
    expect(page).toContain('http-equiv="refresh"')
    expect(page).toContain('url=/')
    expect(page).toContain('<a href="/">')
  })

  it('escapes a hostile Location value', () => {
    const page = tokenHandshakePage('/"><script>alert(1)</script>')
    expect(page).not.toContain('<script>')
    expect(page).toContain('&quot;&gt;&lt;script&gt;')
  })

  it('offers the ?retry escape hatch on the guidance page and never a token', () => {
    const page = handshakeGuidancePage()
    expect(page).toContain('/?retry=1')
    expect(page).not.toContain('token=')
  })
})

/** Upstream stub: `/` without a token is the app, `/?token=…` mints a cookie via 3xx. */
function handshakeUpstream(): Promise<{ server: Server; port: number; seen: string[] }> {
  return new Promise((resolve) => {
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(req.url ?? '/')
      if ((req.url ?? '').startsWith('/?token=')) {
        res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-fresh=minted; Path=/; HttpOnly; SameSite=Strict' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, seen }))
  })
}

describe('token handshake without a redirect loop', () => {
  it('answers the upstream 3xx with a 200 cookie page, then serves the app to the cookie holder', async () => {
    const upstream = await handshakeUpstream()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => true, getPin: async () => '11112222' },
      getDshToken: async () => 'tok-xyz',
    })
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { cookie: 'maestro_pin=11112222' } })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      // The upstream cookie must ride the 200, not the 3xx Safari drops.
      expect(res.headers.get('set-cookie')).toContain('dsh-auth-fresh=minted')
      expect(await res.text()).toContain('http-equiv="refresh"')
      expect(upstream.seen).toEqual(['/?token=tok-xyz'])

      // The browser now holds the minted cookie: the app is served, no second handshake.
      const app = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { cookie: 'maestro_pin=11112222; dsh-auth-fresh=minted' } })
      expect(app.status).toBe(200)
      expect(await app.text()).toBe('ok')
      expect(upstream.seen).toEqual(['/?token=tok-xyz', '/'])
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('caps the handshake counter and serves guidance until ?retry resets it', async () => {
    const upstream = await handshakeUpstream()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => true, getPin: async () => '11112222' },
      getDshToken: async () => 'tok-xyz',
      handshake: { maxHandshakes: 3, windowMs: 60_000 },
    })
    try {
      const headers = { cookie: 'maestro_pin=11112222' }
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await (await fetch(`http://127.0.0.1:${proxy.port}/`, { headers })).text()).toContain('http-equiv="refresh"')
      }
      expect(upstream.seen).toHaveLength(3)

      const capped = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers })
      const cappedBody = await capped.text()
      expect(capped.status).toBe(200)
      expect(cappedBody).toContain('/?retry=1')
      expect(cappedBody).not.toContain('http-equiv="refresh"')
      expect(upstream.seen).toHaveLength(3) // the token was not re-injected

      const retried = await fetch(`http://127.0.0.1:${proxy.port}/?retry=1`, { headers })
      expect(await retried.text()).toContain('http-equiv="refresh"')
      expect(upstream.seen).toHaveLength(4)
      expect(upstream.seen[3]).toBe('/?token=tok-xyz')
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })
})
