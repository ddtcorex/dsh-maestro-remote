import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createRemoteProxy, stripDshAuthCookies, clearDshAuthCookies } from '../src/host/remote-proxy.ts'

function upstreamServer(handler: (url: string) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      handler(req.url ?? '/')
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, port: addr.port })
    })
  })
}

describe('PIN-only: DSH token auto-mint', () => {
  it('injects ?token= on GET / when PIN cookie valid but no dsh-auth cookie', async () => {
    let seenUrl = ''
    const upstream = await upstreamServer((url) => { seenUrl = url })
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => true, getPin: async () => '12345678' },
      getDshToken: async () => 'tok-xyz',
    })
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: { host: 'public.example.com', cookie: 'maestro_pin=12345678' },
      })
      expect(res.status).toBe(200)
      // upstream should have received injected token
      expect(seenUrl).toBe('/?token=tok-xyz')
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('does not inject token when dsh-auth cookie already present', async () => {
    let seenUrl = ''
    const upstream = await upstreamServer((url) => { seenUrl = url })
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => true, getPin: async () => '12345678' },
      getDshToken: async () => 'tok-xyz',
    })
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: { host: 'public.example.com', cookie: 'maestro_pin=12345678; dsh-auth-abc=xyz' },
      })
      expect(res.status).toBe(200)
      expect(seenUrl).toBe('/')
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('does not inject token for non-index paths', async () => {
    let seenUrl = ''
    const upstream = await upstreamServer((url) => { seenUrl = url })
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => true, getPin: async () => '12345678' },
      getDshToken: async () => 'tok-xyz',
    })
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/api/test`, {
        headers: { host: 'public.example.com', cookie: 'maestro_pin=12345678' },
      })
      expect(res.status).toBe(200)
      expect(seenUrl).toBe('/api/test')
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('re-injects ?token= and recovers when upstream rejects stale dsh-auth cookie with 401 on GET /', async () => {
    const requests: { url: string; cookie?: string }[] = []
    const upstream = await new Promise<{ server: Server; port: number }>((resolve) => {
      const server = createServer((req, res) => {
        requests.push({ url: req.url ?? '/', cookie: req.headers.cookie })
        if (req.url === '/') {
          // Stale cookie rejected by upstream BrowserAuth
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('dsh web authentication required')
          return
        }
        if (req.url?.startsWith('/?token=')) {
          // Token exchange succeeds and mints fresh cookie
          res.writeHead(303, {
            location: '/',
            'set-cookie': 'dsh-auth-fresh=token-minted; Path=/; HttpOnly; SameSite=Strict',
          })
          res.end()
          return
        }
        res.writeHead(404)
        res.end()
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        resolve({ server, port: addr.port })
      })
    })

    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => true, getPin: async () => '12345678' },
      getDshToken: async () => 'tok-recovered',
    })

    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: { host: 'public.example.com', cookie: 'maestro_pin=12345678; dsh-auth-old=stale-secret' },
        redirect: 'manual',
      })
      // Proxy should have caught 401, retried with ?token=tok-recovered, and relayed 303 + fresh Set-Cookie
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('/')
      expect(res.headers.get('set-cookie')).toContain('dsh-auth-fresh=token-minted')
      expect(requests).toHaveLength(2)
      expect(requests[0]?.url).toBe('/')
      expect(requests[0]?.cookie).toContain('dsh-auth-old=stale-secret')
      expect(requests[1]?.url).toBe('/?token=tok-recovered')
      // Only dsh-auth-* is stripped on retry; unrelated cookies (maestro_pin) are preserved.
      expect(requests[1]?.cookie).toBe('maestro_pin=12345678')
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('clears stale dsh-auth cookies on non-index 401 responses', async () => {
    const upstream = await new Promise<{ server: Server; port: number }>((resolve) => {
      const server = createServer((_req, res) => {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('unauthorized')
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number }
        resolve({ server, port: addr.port })
      })
    })

    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => true, getPin: async () => '12345678' },
      getDshToken: async () => 'tok-xyz',
    })

    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/api/test`, {
        headers: { host: 'public.example.com', cookie: 'maestro_pin=12345678; dsh-auth-stale=bad' },
      })
      expect(res.status).toBe(401)
      const setCookie = res.headers.get('set-cookie') ?? ''
      expect(setCookie).toContain('dsh-auth-stale=;')
      expect(setCookie).toContain('Max-Age=0')
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('cookie helpers strip and clear dsh-auth cookies correctly', () => {
    expect(stripDshAuthCookies('maestro_pin=123; dsh-auth-abc=xyz; other=val')).toBe('maestro_pin=123; other=val')
    expect(stripDshAuthCookies('dsh-auth-abc=xyz')).toBe('')
    expect(stripDshAuthCookies(undefined)).toBe('')

    const cleared = clearDshAuthCookies('maestro_pin=123; dsh-auth-abc=xyz; dsh-auth-def=uvw')
    expect(cleared).toHaveLength(2)
    expect(cleared[0]).toBe('dsh-auth-abc=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Strict')
    expect(cleared[1]).toBe('dsh-auth-def=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; SameSite=Strict')
    expect(clearDshAuthCookies('maestro_pin=123')).toEqual([])
    expect(clearDshAuthCookies(undefined)).toEqual([])
  })
})

