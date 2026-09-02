import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeLegacyPatch } from '@ddtcorex/dsh-maestro-config-lib'
import { apply } from '../src/host/tunnel.ts'

let home: string
let previousDshHome: string | undefined
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'lan-boot-'))
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})
afterEach(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(home, { recursive: true, force: true })
})

interface Controller {
  proxyStatus(): { running: boolean; port?: number; lanPort?: number; lanUrls: string[]; errorMessage?: string }
  getPin(): Promise<string>
  initialReady(): Promise<void>
  stop(): Promise<unknown>
}

function makeCtx(): { ctx: any; teardown: () => void } {
  const disposers: Array<() => void> = []
  const ctx: any = {
    webServer: { port: 1 },
    effect: (fn: () => (() => void) | void) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    provide: (name: string, value: unknown) => { ctx[name] = value },
    get: () => undefined,
    logger: undefined,
  }
  return { ctx, teardown: () => { for (const d of disposers) d() } }
}

async function boot(settings: Record<string, unknown>): Promise<{ ctx: any; tunnel: Controller; teardown: () => void }> {
  await writeLegacyPatch(settings, { dshHome: home })
  const { ctx, teardown } = makeCtx()
  apply(ctx)
  const tunnel = ctx.maestroTunnel as Controller
  await tunnel.initialReady()
  return { ctx, tunnel, teardown }
}

describe('maestroTunnel LAN proxy listener', () => {
  it('boots a second PIN-gated listener when lanPort is set; LAN login then passes through', async () => {
    const { ctx, tunnel, teardown } = await boot({ lanPort: 0, lanPinEnabled: true })
    try {
      const status = tunnel.proxyStatus()
      expect(status).toBeTruthy()
      expect(typeof status.lanPort).toBe('number')
      const lanPort = status.lanPort as number

      const page = await fetch(`http://127.0.0.1:${lanPort}/`, { headers: { host: 'lan.example.com', accept: 'text/html' } })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('maestro-login-card')

      const pin = await tunnel.getPin()
      const login = await fetch(`http://127.0.0.1:${lanPort}/maestro-login`, {
        method: 'POST',
        headers: { host: 'lan.example.com', 'content-type': 'application/x-www-form-urlencoded' },
        body: `pin=${pin}`,
        redirect: 'manual',
      })
      expect(login.status).toBe(302)
      const cookie = login.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('maestro_pin=')

      // Gate passed -> the request reaches the (unreachable) upstream: 502, not the login page.
      const after = await fetch(`http://127.0.0.1:${lanPort}/`, { headers: { host: 'lan.example.com', cookie } })
      expect(after.status).toBe(502)
      expect(await after.text()).toContain('cannot reach dsh web')

      // Loopback RPC is exempt from the PIN gate on the local listener.
      const rpc = await fetch(`http://127.0.0.1:${lanPort}/dsh-maestro-supervisor-resume/resume`, {
        method: 'POST',
        headers: { host: 'lan.example.com', 'content-type': 'application/json' },
        body: '{}',
      })
      expect(rpc.status).toBe(502) // proxied (exempted), upstream refused
    } finally {
      await ctx.maestroTunnel?.stop()
      teardown()
    }
  })

  it('keeps the LAN listener open when lanPinEnabled is unset (backward compatible)', async () => {
    const { ctx, tunnel, teardown } = await boot({ lanPort: 0 })
    try {
      const lanPort = tunnel.proxyStatus().lanPort as number
      const res = await fetch(`http://127.0.0.1:${lanPort}/`, { headers: { host: 'lan.example.com' } })
      expect(res.status).toBe(502) // proxied through immediately, no login page
      expect(await res.text()).toContain('cannot reach dsh web')
    } finally {
      await ctx.maestroTunnel?.stop()
      teardown()
    }
  })

  it('reports no lanPort when lanPort is unset (current single-listener default)', async () => {
    const { ctx, tunnel, teardown } = await boot({})
    try {
      expect(tunnel.proxyStatus().lanPort).toBeUndefined()
    } finally {
      await ctx.maestroTunnel?.stop()
      teardown()
    }
  })
})