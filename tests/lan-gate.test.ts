import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createRemoteProxy } from '../src/host/remote-proxy.ts'

function upstreamServer(): Promise<{ server: Server; port: number; seen: string[] }> {
  return new Promise((resolve) => {
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(`${req.method ?? ''} ${req.url ?? '/'} host=${String(req.headers.host ?? '')}`)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, port: addr.port, seen })
    })
  })
}

async function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers })
  return { status: res.status, body: await res.text() }
}

describe('local/LAN gate mechanics', () => {
  it('single-PIN: login page without a cookie, then PIN cookie passes through to the upstream', async () => {
    const upstream = await upstreamServer()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => false, getPin: async () => '12345678', getLanPin: async () => '12345678' },
    })
    try {
      const page = await get(proxy.port, '/', { host: 'lan.example.com', accept: 'text/html' })
      expect(page.status).toBe(200)
      expect(page.body).toContain('maestro-login-card') // login page, not the app

      const login = await fetch(`http://127.0.0.1:${proxy.port}/maestro-login`, {
        method: 'POST',
        headers: { host: 'lan.example.com', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'pin=12345678',
        redirect: 'manual',
      })
      expect(login.status).toBe(302)
      expect(login.headers.get('set-cookie')).toContain('maestro_pin=12345678')

      const after = await get(proxy.port, '/', { host: 'lan.example.com', cookie: 'maestro_pin=12345678' })
      expect(after.status).toBe(200)
      expect(after.body).toBe('ok') // proxied upstream, not the login page
      expect(upstream.seen.some((s) => s.includes('host=127.0.0.1:'))).toBe(true) // loopbackAuthority
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('gateExemptPathPrefixes bypasses the PIN gate on this listener', async () => {
    const upstream = await upstreamServer()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => false, getPin: async () => '12345678', getLanPin: async () => '12345678' },
      gateExemptPathPrefixes: ['/dsh-maestro-supervisor-resume'],
    })
    try {
      const res = await get(proxy.port, '/dsh-maestro-supervisor-resume/resume', { host: 'lan.example.com', 'content-type': 'application/json' })
      expect(res.status).toBe(200) // no PIN cookie, still proxied
      expect(res.body).toBe('ok')
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('without the exemption the same RPC path is 401 without a cookie', async () => {
    const upstream = await upstreamServer()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => false, getPin: async () => '12345678', getLanPin: async () => '12345678' },
    })
    try {
      const res = await get(proxy.port, '/dsh-maestro-supervisor-resume/resume', { host: 'lan.example.com' })
      expect(res.status).toBe(401)
      expect(res.body).toContain('unauthorized')
      expect(upstream.seen.length).toBe(0)
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('no getLanPin on a non-public listener keeps LAN open (current default)', async () => {
    const upstream = await upstreamServer()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => false, getPin: async () => '12345678' },
    })
    try {
      const res = await get(proxy.port, '/', { host: 'lan.example.com' })
      expect(res.status).toBe(200)
      expect(res.body).toBe('ok')
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })
})