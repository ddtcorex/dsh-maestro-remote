import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createRemoteProxy } from '../src/host/remote-proxy.ts'

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
})
