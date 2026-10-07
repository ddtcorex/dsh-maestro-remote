// The proxy mints the dsh browser cookie from `connection.authenticatedUrl()`.
// The tunnel row cannot declare `inject: ['connection']` (that reorders the
// load and silences the startup notification, see the comment above `inject`
// in tunnel.ts), and on DSH 0.2.x neither `ctx.connection` nor
// `ctx.get('connection')` resolves from a row that did not inject it. The
// supported way to reach an optional service without deferring apply() is a
// nested `ctx.inject(['connection'], ...)`. Before the fix the PIN was
// accepted but the upstream never got a token, so every page answered 401.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeLegacyPatch } from '../src/host/vendor/store.js'
import { apply } from '../src/host/tunnel.ts'

let home: string
let previousDshHome: string | undefined
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-token-'))
  previousDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
})
afterEach(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  await rm(home, { recursive: true, force: true })
})

describe('dsh token minting without a row-level connection inject', () => {
  it('forwards the token from a nested ctx.inject(connection)', async () => {
    const seen: string[] = []
    const upstream = createServer((req, res) => { seen.push(req.url ?? '/'); res.end('ok') })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
    const upstreamPort = (upstream.address() as { port: number }).port
    await writeLegacyPatch({ proxyPort: 0, tunnelHostname: 'dsh.example.com' }, { dshHome: home })

    const disposers: Array<() => void> = []
    const ctx: any = {
      webServer: { port: upstreamPort },
      effect: (fn: () => (() => void) | void) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return d },
      provide: (name: string, value: unknown) => { Object.defineProperty(ctx, name, { value, configurable: true }) },
      // A row that did not inject the service: both lookups come up empty/throw.
      get connection(): never { throw new Error('cannot get property "connection" without inject') },
      get: () => undefined,
      inject: (_deps: string[], cb: (c: any) => void) => {
        cb({ connection: { authenticatedUrl: (u: string) => `${u}/?token=tok-nested` } })
      },
    }
    apply(ctx)
    try {
      const tunnel = ctx.maestroTunnel
      await tunnel.initialReady()
      const port = tunnel.proxyStatus().port as number
      const pin = await tunnel.getPin()
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { host: 'dsh.example.com', cookie: `maestro_pin=${pin}` },
      })
      expect(res.status).toBe(200)
      expect(seen).toContain('/?token=tok-nested')
    } finally {
      for (const d of disposers) d()
      upstream.close()
    }
  })
})
