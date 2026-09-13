import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createRemoteProxy, stripDshAuthCookies, clearDshAuthCookies, stripDesktopQueryParams } from '../src/host/remote-proxy.ts'

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

  it('re-injects ?token= and answers the upstream 3xx with a 200 cookie page when a stale dsh-auth cookie is rejected', async () => {
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
      // The proxy caught the 401, retried with ?token=tok-recovered, and turns
      // the upstream 3xx into a 200 page: the fresh cookie must ride a 200,
      // because Safari drops a Set-Cookie sent on a redirect from a bare http origin.
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(res.headers.get('set-cookie')).toContain('dsh-auth-fresh=token-minted')
      const body = await res.text()
      expect(body).toContain('http-equiv="refresh"')
      expect(body).toContain('url=/')
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


describe('dsh-desktop-* bootstrap params', () => {
  it('strips them and forwards everything else', () => {
    expect(stripDesktopQueryParams('/?dsh-desktop-session=abc&keep=1')).toBe('/?keep=1')
    expect(stripDesktopQueryParams('/api/x?dsh-desktop-a=1&dsh-desktop-b=2')).toBe('/api/x')
    expect(stripDesktopQueryParams('/?keep=1')).toBe('/?keep=1')
    expect(stripDesktopQueryParams('/')).toBe('/')
    expect(stripDesktopQueryParams('/?dsh-desktop-a=1#/route?dsh-desktop-b=2')).toBe('/#/route?dsh-desktop-b=2')
  })

  it('does not forward a dsh-desktop-* param upstream on an index request', async () => {
    let seenUrl = ''
    const upstream = await upstreamServer((url) => { seenUrl = url })
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => true, getPin: async () => '12345678' },
    })
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/?dsh-desktop-session=abc&keep=1`, {
        headers: { cookie: 'maestro_pin=12345678' },
      })
      expect(res.status).toBe(200)
      expect(seenUrl).toBe('/?keep=1')
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('does not forward them on a non-index path either', async () => {
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
      const res = await fetch(`http://127.0.0.1:${proxy.port}/api/session?dsh-desktop-handoff=secret`, {
        headers: { cookie: 'maestro_pin=12345678' },
      })
      expect(res.status).toBe(200)
      expect(seenUrl).toBe('/api/session')
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })
})
