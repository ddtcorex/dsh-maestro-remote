import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PIN_SESSION_TTL_HOURS,
  MAX_PIN_SESSION_TTL_HOURS,
  resolvePinSessionTtlHours,
  pinSessionCookie,
} from '../src/host/remote-proxy.ts'

describe('resolvePinSessionTtlHours', () => {
  it('uses the product default when the setting is absent', () => {
    expect(DEFAULT_PIN_SESSION_TTL_HOURS).toBe(24)
    expect(resolvePinSessionTtlHours(undefined)).toBe(24)
    expect(resolvePinSessionTtlHours(null)).toBe(24)
  })

  it('treats zero and negatives as session-only', () => {
    expect(resolvePinSessionTtlHours(0)).toBe(0)
    expect(resolvePinSessionTtlHours(-5)).toBe(0)
  })

  it('fails closed on unusable values instead of granting a long session', () => {
    for (const bad of ['24', '', Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) {
      expect(resolvePinSessionTtlHours(bad)).toBe(0)
    }
  })

  it('accepts and rounds positive values', () => {
    expect(resolvePinSessionTtlHours(1)).toBe(1)
    expect(resolvePinSessionTtlHours(168)).toBe(168)
    expect(resolvePinSessionTtlHours(1.5)).toBe(2)
    expect(resolvePinSessionTtlHours(0.4)).toBe(0)
  })

  it('clamps above the maximum', () => {
    expect(MAX_PIN_SESSION_TTL_HOURS).toBe(8760)
    expect(resolvePinSessionTtlHours(8760)).toBe(8760)
    expect(resolvePinSessionTtlHours(1e9)).toBe(8760)
  })
})

describe('pinSessionCookie', () => {
  it('always keeps the hardened attributes and the bare PIN value', () => {
    const cookie = pinSessionCookie('12345678', 24)
    expect(cookie.startsWith('maestro_pin=12345678;')).toBe(true)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    // No Secure attribute: the LAN listener serves plain HTTP (see spec D7).
    expect(cookie).not.toContain('Secure')
  })

  it('adds Max-Age and a matching Expires for a positive lifetime', () => {
    const before = Date.now()
    const cookie = pinSessionCookie('12345678', 24)
    expect(cookie).toContain('Max-Age=86400')
    const expires = /Expires=([^;]+)/.exec(cookie)?.[1]
    expect(expires).toBeDefined()
    const at = new Date(String(expires)).getTime()
    expect(at).toBeGreaterThanOrEqual(before + 86_400_000 - 5_000)
    expect(at).toBeLessThanOrEqual(before + 86_400_000 + 5_000)
    expect(pinSessionCookie('12345678', 1)).toContain('Max-Age=3600')
    expect(pinSessionCookie('12345678', 168)).toContain('Max-Age=604800')
  })

  it('emits a session cookie (no Max-Age, no Expires) for zero', () => {
    const cookie = pinSessionCookie('12345678', 0)
    expect(cookie).toBe('maestro_pin=12345678; HttpOnly; SameSite=Lax; Path=/')
  })
})

import { createServer, type Server } from 'node:http'
import { createRemoteProxy } from '../src/host/remote-proxy.ts'

function upstreamServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

async function login(port: number, host: string, pin: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/maestro-login`, {
    method: 'POST',
    headers: { host, 'content-type': 'application/x-www-form-urlencoded' },
    body: `pin=${pin}`,
    redirect: 'manual',
  })
  expect(res.status).toBe(302)
  return res.headers.get('set-cookie') ?? ''
}

describe('login cookie lifetime', () => {
  async function withProxy(
    getPinSessionTtlHours: (() => Promise<number | undefined>) | undefined,
    body: (port: number) => Promise<void>,
  ): Promise<void> {
    const upstream = await upstreamServer()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: {
        isPublic: () => true,
        getPin: async () => '12345678',
        ...(getPinSessionTtlHours === undefined ? {} : { getPinSessionTtlHours }),
      },
    })
    try {
      await body(proxy.port)
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  }

  it('defaults to a one-day persistent cookie when nothing is configured', async () => {
    await withProxy(undefined, async (port) => {
      expect(await login(port, 'public.example.com', '12345678')).toContain('Max-Age=86400')
    })
  })

  it('honours a configured lifetime', async () => {
    await withProxy(async () => 8, async (port) => {
      expect(await login(port, 'public.example.com', '12345678')).toContain('Max-Age=28800')
    })
  })

  it('keeps the session cookie when the lifetime is zero', async () => {
    await withProxy(async () => 0, async (port) => {
      const cookie = await login(port, 'public.example.com', '12345678')
      expect(cookie).toContain('maestro_pin=12345678')
      expect(cookie).not.toContain('Max-Age')
      expect(cookie).not.toContain('Expires')
    })
  })

  it('fails closed when the getter returns a hand-edited value', async () => {
    await withProxy(async () => 'abc' as unknown as number, async (port) => {
      expect(await login(port, 'public.example.com', '12345678')).not.toContain('Max-Age')
    })
  })

  it('still authorizes the request when the whole Set-Cookie value is replayed as a cookie header', async () => {
    // Regression pin: the login cookie now carries extra attributes, and the LAN
    // listener's own test replays the raw Set-Cookie string as the request Cookie.
    await withProxy(async () => 24, async (port) => {
      const cookie = await login(port, 'public.example.com', '12345678')
      const after = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: 'public.example.com', cookie } })
      expect(after.status).toBe(200)
      expect(await after.text()).toBe('ok')
    })
  })
})
