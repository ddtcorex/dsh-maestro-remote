import { describe, it, expect } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { createRemoteProxy, clientIdentity, isLoopbackAddress, policyHost } from '../src/host/remote-proxy.ts'

describe('clientIdentity (login throttle key)', () => {
  it('trusts a forwarded client IP only from a loopback peer', () => {
    expect(clientIdentity('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })).toBe('203.0.113.7')
    expect(clientIdentity('::1', { 'cf-connecting-ip': '203.0.113.7' })).toBe('203.0.113.7')
    expect(clientIdentity('::ffff:127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' })).toBe('203.0.113.7')
  })

  it('ignores forwarded headers from a non-loopback peer', () => {
    // A LAN client must not be able to pick someone else's bucket.
    expect(clientIdentity('192.0.2.10', { 'cf-connecting-ip': '203.0.113.7' })).toBe('192.0.2.10')
    expect(clientIdentity('192.0.2.10', { 'x-forwarded-for': '203.0.113.7' })).toBe('192.0.2.10')
  })

  it('takes the first hop of X-Forwarded-For and tolerates array headers', () => {
    expect(clientIdentity('127.0.0.1', { 'x-forwarded-for': '203.0.113.7, 70.41.3.18' })).toBe('203.0.113.7')
    expect(clientIdentity('127.0.0.1', { 'x-forwarded-for': ['203.0.113.7', '70.41.3.18'] })).toBe('203.0.113.7')
  })

  it('falls back to the peer when no usable forwarded header exists', () => {
    expect(clientIdentity('127.0.0.1', {})).toBe('127.0.0.1')
    expect(clientIdentity('127.0.0.1', { 'cf-connecting-ip': '   ' })).toBe('127.0.0.1')
    expect(clientIdentity(undefined, {})).toBe('unknown')
  })

  it('recognises the loopback spellings', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.0.2.10')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe('policyHost (classification never weakens)', () => {
  it('keeps a public listener public no matter what Host the client claims', () => {
    // Forging `Host: 127.0.0.1` on the tunnel ingress must not drop the request
    // into the LAN class (which is open when no LAN PIN is configured).
    expect(policyHost(false, 'public')).toBe(true)
    expect(policyHost(true, 'public')).toBe(true)
  })

  it('never promotes a LAN listener to public', () => {
    expect(policyHost(false, 'lan')).toBe(false)
    expect(policyHost(true, 'lan')).toBe(true) // an explicit tunnel-hostname match still counts
  })
})

const WRONG = '00000000'

function upstreamServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

function loginAttempt(
  port: number,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const body = `pin=${WRONG}`
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/maestro-login',
        headers: { host: 'public.example.com', 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length), ...headers },
      },
      (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })) },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

describe('login throttling per forwarded client', () => {
  it('throttles the offending client, not every visitor behind the tunnel', async () => {
    const upstream = await upstreamServer()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => true, getPin: async () => '11112222' },
      // The default is 5 failures / 10 minutes; keep it explicit so the test
      // does not depend on the default drifting.
      loginRateLimit: { maxFailures: 3, windowMs: 60_000 },
    })
    try {
      const attacker = { 'cf-connecting-ip': '203.0.113.7' }
      const owner = { 'cf-connecting-ip': '198.51.100.4' }
      expect((await loginAttempt(proxy.port, attacker)).status).toBe(200)
      expect((await loginAttempt(proxy.port, attacker)).status).toBe(200)
      expect((await loginAttempt(proxy.port, attacker)).status).toBe(200)
      // Fourth attempt from the same forwarded IP is throttled…
      expect((await loginAttempt(proxy.port, attacker)).status).toBe(429)
      // …while a different visitor behind the same loopback peer is untouched.
      expect((await loginAttempt(proxy.port, owner)).status).toBe(200)
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })
})
