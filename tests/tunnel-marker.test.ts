import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NAMED_CONFIG = {
  tunnelMode: 'named' as const,
  tunnelId: 'test-tunnel',
  tunnelCredentialsFile: '/tmp/creds.json',
  tunnelHostname: 'tunnel.example.com',
  proxyPort: 39001,
  lastTunnelRunning: true,
}

const { mockSpawn, configState, gate } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  configState: { saved: [] as Array<Record<string, unknown>>, loadCalls: 0 },
  gate: { parkFromCall: Number.POSITIVE_INFINITY, waiters: [] as Array<() => void> },
}))

class FakeChild extends EventEmitter {
  stdout = null
  stderr = null
  kill = vi.fn()
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Array<unknown>) => mockSpawn(...args) }
})

vi.mock('../src/host/config-store.ts', () => ({
  loadUserConfig: async () => {
    configState.loadCalls += 1
    if (configState.loadCalls >= gate.parkFromCall) {
      await new Promise<void>((resolve) => { gate.waiters.push(resolve) })
    }
    return { ...NAMED_CONFIG }
  },
  saveUserConfig: async (patch: Record<string, unknown>) => {
    configState.saved.push({ ...patch })
    return patch
  },
}))

vi.mock('../src/host/remote-proxy.ts', () => ({
  createRemoteProxy: async () => ({ port: 39001, close: async () => {} }),
  isPublicHost: () => false,
  policyHost: () => true,
  lanUrls: () => [],
  resolvePinSessionTtlHours: () => 24,
}))

vi.mock('../src/host/pin-store.ts', () => ({
  readPin: async () => '11111111',
  readLanPin: async () => '22222222',
  rotatePin: async () => '11111111',
  rotateLanPin: async () => '22222222',
}))

vi.mock('../src/host/startup-notify.ts', () => ({ scheduleStartupNotification: () => {} }))

import { apply } from '../src/host/tunnel.ts'

let home: string
let previousDshHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tunnel-marker-'))
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  configState.saved = []
  configState.loadCalls = 0
  gate.parkFromCall = Number.POSITIVE_INFINITY
  gate.waiters = []
  mockSpawn.mockReset()
  mockSpawn.mockImplementation(() => new FakeChild())
})

afterEach(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(home, { recursive: true, force: true })
})

function boot(): { tunnel: any; disposers: Array<() => void> } {
  const disposers: Array<() => void> = []
  const ctx: any = {
    webServer: { port: 3099 },
    effect: (fn: () => (() => void) | void) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    provide: (name: string, value: unknown) => { ctx[name] = value },
    get: () => undefined,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  apply(ctx)
  return { tunnel: ctx.maestroTunnel, disposers }
}

describe('lastTunnelRunning marker writes', () => {
  it('writes the marker through one serialized path in call order', async () => {
    const { tunnel, disposers } = boot()
    await tunnel.initialReady()
    expect(configState.saved).toEqual([{ lastTunnelRunning: true }])
    await tunnel.stop()
    expect(configState.saved).toEqual([{ lastTunnelRunning: true }, { lastTunnelRunning: false }])
    for (const dispose of disposers) dispose()
  })

  it('does not resurrect the marker when a stop() races an in-flight start()', async () => {
    gate.parkFromCall = 3 // calls 1-2 are bootProxy/auto-restore; call 3 is start()'s own read
    const { tunnel, disposers } = boot()
    const ready = tunnel.initialReady()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(gate.waiters).toHaveLength(1) // start() is parked inside loadUserConfig

    await tunnel.stop()
    expect(configState.saved).toEqual([{ lastTunnelRunning: false }])

    gate.waiters[0]?.() // let the aborted start() continue
    await ready
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The late start() must not write `true` after the explicit stop.
    expect(configState.saved).toEqual([{ lastTunnelRunning: false }])
    for (const dispose of disposers) dispose()
  })
})
