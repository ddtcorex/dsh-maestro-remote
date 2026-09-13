import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
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
  proxyStatus(): { running: boolean; port?: number; lanPort?: number; lanUrls: string[]; lanPinRequired?: boolean; errorMessage?: string; deploymentError?: string }
  getPin(): Promise<string>
  getLanPin(): Promise<string>
  initialReady(): Promise<void>
  stop(): Promise<unknown>
}

function makeCtx(webPort = 1, webStartupPort?: number): { ctx: any; teardown: () => void } {
  const disposers: Array<() => void> = []
  const ctx: any = {
    webServer: { port: webPort },
    effect: (fn: () => (() => void) | void) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    provide: (name: string, value: unknown) => { ctx[name] = value },
    get: (name: string) => name === 'webStartup' ? (webStartupPort === undefined ? undefined : { port: webStartupPort }) : undefined,
    logger: undefined,
  }
  return { ctx, teardown: () => { for (const d of disposers) d() } }
}

/** fetch() cannot send a Host header (forbidden name) — this test needs a real one. */
function getWithHost(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'GET', path: '/', headers: { host, accept: 'text/html' } },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function boot(settings: Record<string, unknown>, webPort = 1, webStartupPort?: number): Promise<{ ctx: any; tunnel: Controller; teardown: () => void }> {
  await writeLegacyPatch(settings, { dshHome: home })
  const { ctx, teardown } = makeCtx(webPort, webStartupPort)
  apply(ctx)
  const tunnel = ctx.maestroTunnel as Controller
  await tunnel.initialReady()
  return { ctx, tunnel, teardown }
}

describe('maestroTunnel public listener classification', () => {
  it('stays public even when the client forges a private Host header', async () => {
    const { tunnel, teardown } = await boot({ proxyPort: 0, tunnelHostname: 'dsh.example.com' })
    try {
      const port = tunnel.proxyStatus().port as number
      // Before the fix this fell into the LAN class, which is unauthenticated
      // when no LAN PIN is configured — one header bypassed the public PIN.
      const res = await getWithHost(port, '127.0.0.1')
      expect(res.status).toBe(200)
      expect(res.body).toContain('maestro-login-card')
    } finally {
      teardown()
    }
  })
})

describe('maestroTunnel LAN proxy listener', () => {
  it('advertises the LAN listener URL and the fact that a PIN is required', async () => {
    const { tunnel, teardown } = await boot({ lanPort: 0, lanPinEnabled: true })
    try {
      const status = tunnel.proxyStatus()
      // The card must describe the listener the LAN PIN actually opens;
      // advertising the public listener's port paired with the LAN PIN was the
      // defect (an unloggable URL+PIN pair).
      expect(status.lanPinRequired).toBe(true)
      if (status.lanUrls.length > 0) {
        expect(status.lanUrls[0]).toContain(`:${status.lanPort}`)
        expect(status.lanUrls[0]).not.toContain(`:${status.port}`)
      }
    } finally {
      teardown()
    }
  })

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

      // Every host on the LAN listener is LAN-class, so its gate is the LAN PIN.
      const pin = await tunnel.getLanPin()
      const login = await fetch(`http://127.0.0.1:${lanPort}/maestro-login`, {
        method: 'POST',
        headers: { host: 'lan.example.com', 'content-type': 'application/x-www-form-urlencoded' },
        body: `pin=${pin}`,
        redirect: 'manual',
      })
      expect(login.status).toBe(302)
      const cookie = login.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('maestro_lan_pin=')

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

  it('fail-closes the half-deploy: webserver off :3080 with no lanPort surfaces a deployment error', async () => {
    // makeCtx webPort defaults to 1 (never the canonical 3080): the exact
    // 2026-09-02 shape where the profile moved the webserver away but the
    // LAN proxy was never enabled — previously :3080 silently went dead.
    const { ctx, tunnel, teardown } = await boot({})
    try {
      const status = tunnel.proxyStatus()
      expect(status.deploymentError).toBeTruthy()
      expect(status.deploymentError).toContain('lanPort is not configured')
      expect(status.deploymentError).toContain('http://127.0.0.1:3080')
      expect(status.lanPort).toBeUndefined()
    } finally {
      await ctx.maestroTunnel?.stop()
      teardown()
    }
  })

  it('no deployment error when the webserver is on :3080 and lanPort is unset', async () => {
    const { ctx, tunnel, teardown } = await boot({}, 3080)
    try {
      expect(tunnel.proxyStatus().deploymentError).toBeUndefined()
      expect(tunnel.proxyStatus().lanPort).toBeUndefined()
    } finally {
      await ctx.maestroTunnel?.stop()
      teardown()
    }
  })

  it('suppresses the deployment error for an explicit custom port (dry-boot via --port)', async () => {
    // A dry-boot passes `--port <ephemeral>` (webStartup.port set): the
    // canonical :3080 is intentionally not part of that isolated run, so the
    // fail-closed gate must not flag it as a half-deploy.
    const { ctx, tunnel, teardown } = await boot({}, 4567, 4567)
    try {
      expect(tunnel.proxyStatus().deploymentError).toBeUndefined()
      expect(tunnel.proxyStatus().lanPort).toBeUndefined()
    } finally {
      await ctx.maestroTunnel?.stop()
      teardown()
    }
  })

  it('no deployment error when lanPort is configured (webserver moved is intentional)', async () => {
    const { ctx, tunnel, teardown } = await boot({ lanPort: 0 }, 3082)
    try {
      expect(tunnel.proxyStatus().deploymentError).toBeUndefined()
      expect(typeof tunnel.proxyStatus().lanPort).toBe('number')
    } finally {
      await ctx.maestroTunnel?.stop()
      teardown()
    }
  })
})