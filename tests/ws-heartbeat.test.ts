import { describe, it, expect } from 'vitest'
import { connect, type Socket } from 'node:net'
import { createServer, type Server } from 'node:http'
import {
  createRemoteProxy,
  createWsHeartbeat,
  resetAndDestroyUpstream,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_HEARTBEAT_MISSED_LIMIT,
  WS_PING_FRAME,
} from '../src/host/remote-proxy.ts'

describe('createWsHeartbeat', () => {
  it('counts a silent interval as missed and forgets it when data arrives', () => {
    const timers: Array<() => void> = []
    let dead = 0
    const heartbeat = createWsHeartbeat(
      { onDead: () => { dead += 1 } },
      {
        setInterval: (handler) => { timers.push(handler); return 1 as unknown as ReturnType<typeof setInterval> },
        clearInterval: () => {},
      },
    )
    timers[0]?.()
    expect(heartbeat.missed).toBe(1)
    heartbeat.noteActivity()
    expect(heartbeat.missed).toBe(0)
    timers[0]?.()
    expect(heartbeat.missed).toBe(1)
    expect(dead).toBe(0)
    expect(heartbeat.disposed).toBe(false)
  })

  it('declares the peer dead after two silent intervals and stops the timer', () => {
    const timers: Array<() => void> = []
    let dead = 0
    let clears = 0
    const heartbeat = createWsHeartbeat(
      { onDead: () => { dead += 1 } },
      {
        setInterval: (handler) => { timers.push(handler); return 1 as unknown as ReturnType<typeof setInterval> },
        clearInterval: () => { clears += 1 },
      },
    )
    timers[0]?.()
    timers[0]?.()
    expect(dead).toBe(1)
    expect(heartbeat.disposed).toBe(true)
    expect(clears).toBe(1)
    timers[0]?.() // the interval already stopped
    expect(dead).toBe(1)
  })

  it('dispose is idempotent and silences later ticks', () => {
    const timers: Array<() => void> = []
    let dead = 0
    const heartbeat = createWsHeartbeat(
      { onDead: () => { dead += 1 } },
      {
        setInterval: (handler) => { timers.push(handler); return 2 as unknown as ReturnType<typeof setInterval> },
        clearInterval: () => {},
      },
    )
    heartbeat.dispose()
    heartbeat.dispose()
    timers[0]?.()
    expect(dead).toBe(0)
    expect(heartbeat.disposed).toBe(true)
  })

  it('asks the caller to probe (ping) on every silent interval', () => {
    const timers: Array<() => void> = []
    let idles = 0
    createWsHeartbeat(
      { onDead: () => {}, onIdle: () => { idles += 1 } },
      {
        setInterval: (handler) => { timers.push(handler); return 3 as unknown as ReturnType<typeof setInterval> },
        clearInterval: () => {},
      },
    )
    timers[0]?.()
    timers[0]?.()
    expect(idles).toBe(2)
  })

  it('probes every 30s and tolerates two silent intervals in production', () => {
    expect(WS_HEARTBEAT_INTERVAL_MS).toBe(30_000)
    expect(WS_HEARTBEAT_MISSED_LIMIT).toBe(2)
  })
})

describe('resetAndDestroyUpstream', () => {
  it('prefers resetAndDestroy and falls back to destroy', () => {
    const preferred: string[] = []
    resetAndDestroyUpstream({ resetAndDestroy: () => preferred.push('reset'), destroy: () => preferred.push('destroy') })
    expect(preferred).toEqual(['reset'])
    const fallback: string[] = []
    resetAndDestroyUpstream({ destroy: () => fallback.push('destroy') })
    expect(fallback).toEqual(['destroy'])
  })
})

/** Upstream that accepts the upgrade so the proxy has a real peer socket. */
function upgradeUpstream(): Promise<{ server: Server; port: number; upgraded: () => number; closed: () => number }> {
  return new Promise((resolve) => {
    let upgraded = 0
    let closed = 0
    const server = createServer((_req, res) => { res.writeHead(404); res.end() })
    server.on('upgrade', (_req, socket) => {
      upgraded += 1
      // The proxy resets this socket on teardown, so an ECONNRESET error event
      // is expected; without a listener it would crash the test process.
      socket.on('error', () => {})
      socket.on('close', () => { closed += 1 })
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port, upgraded: () => upgraded, closed: () => closed })
    })
  })
}

/** Poll a predicate so a socket event never has to land inside a fixed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
}

/**
 * Raw WebSocket handshake through the proxy; resolves once the 101 arrived.
 * `sec-websocket-key` here is the RFC 6455 example value, not a secret.
 */
function openUpgrade(port: number): Promise<{ socket: Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      // Without this, Nagle plus the peer's delayed ACK coalesce the small
      // frames below into one chunk that can land after the probe interval.
      socket.setNoDelay(true)
      socket.write([
        'GET /ws HTTP/1.1',
        'Host: tunnel.example.com',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '',
        '',
      ].join('\r\n'))
    })
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1')
      if (buffer.includes('\r\n\r\n')) {
        socket.off('data', onData)
        resolve({ socket, response: buffer })
      }
    }
    socket.on('data', onData)
    socket.on('error', reject)
  })
}

describe('WebSocket liveness through the proxy', () => {
  it('destroys a socket with no inbound data after two missed intervals so the client reconnects', async () => {
    const upstream = await upgradeUpstream()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => false, getPin: async () => '11112222' },
      wsHeartbeat: { intervalMs: 25, missedLimit: 2 },
    })
    try {
      const { socket, response } = await openUpgrade(proxy.port)
      expect(response.startsWith('HTTP/1.1 101')).toBe(true)
      expect(upstream.upgraded()).toBe(1)
      const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()))
      await closed
      expect(socket.destroyed).toBe(true)
      // Teardown resets the upstream socket, so the upstream sees it close too.
      await waitFor(() => upstream.closed() === 1)
      expect(upstream.closed()).toBe(1)
    } finally {
      await proxy.close()
      upstream.server.close()
    }
  })

  it('keeps an idle client that answers the ping, so a quiet session is not killed', async () => {
    // DSH's client sends nothing of its own while idle, so a heartbeat that
    // only watches client traffic would tear down healthy sessions every
    // interval. RFC 6455 requires a pong in reply to a ping, which is the
    // liveness signal this test pins.
    const upstream = await upgradeUpstream()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => false, getPin: async () => '11112222' },
      wsHeartbeat: { intervalMs: 25, missedLimit: 2 },
    })
    const { socket } = await openUpgrade(proxy.port)
    let pings = 0
    const respondToPing = (chunk: Buffer): void => {
      // A client frame is masked: empty pong = 0x8A, mask bit, 4-byte key.
      if (chunk.includes(WS_PING_FRAME[0] as number)) {
        pings += 1
        if (!socket.destroyed) socket.write(Buffer.from([0x8a, 0x80, 0, 0, 0, 0]))
      }
    }
    socket.on('data', respondToPing)
    try {
      // Six probe intervals, no client chatter of its own.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(pings).toBeGreaterThan(0)
      expect(socket.destroyed).toBe(false)
      expect(upstream.closed()).toBe(0)
    } finally {
      socket.off('data', respondToPing)
      await proxy.close()
      upstream.server.close()
    }
  })

  it('leaves a socket that keeps sending data untouched', async () => {
    const upstream = await upgradeUpstream()
    const proxy = await createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: upstream.port },
      auth: { isPublic: () => false, getPin: async () => '11112222' },
      wsHeartbeat: { intervalMs: 25, missedLimit: 2 },
    })
    const { socket } = await openUpgrade(proxy.port)
    // A live client keeps talking; each chunk counts as inbound activity.
    const talking = setInterval(() => { if (!socket.destroyed) socket.write(Buffer.from([0x81, 0x80, 0x11, 0x22, 0x33, 0x44])) }, 10)
    try {
      // Four probe intervals with traffic in each: the socket must survive.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(socket.destroyed).toBe(false)
      expect(upstream.upgraded()).toBe(1)
      expect(upstream.closed()).toBe(0)
    } finally {
      clearInterval(talking)
      await proxy.close()
      upstream.server.close()
    }
  })
})
