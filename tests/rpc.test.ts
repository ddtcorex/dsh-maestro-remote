import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRpcHandler, RPC_CHANNEL } from '../src/host/rpc.js'

/**
 * These nine endpoints moved here from dsh-maestro-review, which hosted them
 * on `/dsh-maestro-review` while delegating every one of them to this
 * package's own `maestroTunnel` service.
 *
 * The envelope is the point of the move. Review's stub and its old handlers
 * answered a bare `{ ok: true }` with no `value`, and every client reads
 * `res.value` — so the Settings card rendered an empty form that saved nothing,
 * with no error anywhere.
 */

let home: string
let realHome: string | undefined
let sent: Array<{ text: unknown }>

function deps() {
  const maestroTunnel = {
    status: vi.fn(() => ({ status: 'running' })),
    start: vi.fn(async () => ({ status: 'running' })),
    stop: vi.fn(async () => ({ status: 'stopped' })),
    proxyStatus: vi.fn(() => ({ running: true, port: 3080 })),
    reloadConfig: vi.fn(async () => {}),
    initialReady: vi.fn(async () => {}),
    getPin: vi.fn(async () => '11112222'),
    rotatePin: vi.fn(async () => '33334444'),
    getLanPin: vi.fn(async () => '55556666'),
    rotateLanPin: vi.fn(async () => '77778888'),
  }
  const notifier = { send: vi.fn(async () => ({ sent: true })) }
  const handler = createRpcHandler({ tunnel: maestroTunnel as never, notifier: notifier as never, logger: { info: vi.fn(), warn: vi.fn() } })
  return { handler, maestroTunnel, notifier }
}

beforeEach(() => {
  realHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'remote-rpc-'))
  process.env.DSH_HOME = home
  sent = []
})
afterEach(() => {
  if (realHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

describe('the RpcResult envelope', () => {
  it('answers a known endpoint with ok and a value, never a bare ok', async () => {
    const { handler } = deps()
    const res: any = await handler('maestro.status', {})
    expect(res.ok).toBe(true)
    expect(res).toHaveProperty('value')
    expect(res.value).toEqual({ status: 'running' })
  })

  it('answers an unknown endpoint with ok:false and a message', async () => {
    const { handler } = deps()
    const res: any = await handler('maestro.nope', {})
    expect(res.ok).toBe(false)
    expect(typeof res.error).toBe('string')
  })

  it('turns a thrown tunnel failure into ok:false instead of rejecting', async () => {
    const { handler, maestroTunnel } = deps()
    maestroTunnel.start.mockRejectedValueOnce(new Error('cloudflared missing'))
    const res: any = await handler('maestro.tunnelStart', {})
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/cloudflared missing/)
  })

  it('serves on this package own channel', () => {
    expect(RPC_CHANNEL).toBe('/dsh-maestro-remote')
  })
})

describe('tunnel and proxy endpoints', () => {
  it('delegates status, start, stop and proxyStatus to the tunnel service', async () => {
    const { handler, maestroTunnel } = deps()
    await handler('maestro.status', {})
    await handler('maestro.tunnelStart', {})
    await handler('maestro.tunnelStop', {})
    const proxy: any = await handler('maestro.proxyStatus', {})
    expect(maestroTunnel.status).toHaveBeenCalled()
    expect(maestroTunnel.start).toHaveBeenCalled()
    expect(maestroTunnel.stop).toHaveBeenCalled()
    expect(proxy.value).toEqual({ running: true, port: 3080 })
  })
})

describe('PIN endpoints', () => {
  it('getPin returns the service value, not a hardcoded one', async () => {
    const { handler } = deps()
    const res: any = await handler('maestro.getPin', {})
    expect(res.value).toEqual({ pin: '11112222' })
  })

  it('rotatePin returns the rotated value and notifies once', async () => {
    const { handler, maestroTunnel, notifier } = deps()
    // The notifier target is the notifier domain, which review used to own.
    const { set } = await import('../src/host/vendor/store.js')
    await set('notifier', { telegram: { botToken: '123:abc', chatId: '-100' } })
    const res: any = await handler('maestro.rotatePin', {})
    expect(maestroTunnel.rotatePin).toHaveBeenCalled()
    expect(res.value).toEqual({ pin: '33334444' })
    await new Promise((r) => setTimeout(r, 10))
    expect(notifier.send).toHaveBeenCalledTimes(1)
    expect(String((notifier.send.mock.calls[0] as unknown[])[2]?.text ?? JSON.stringify(notifier.send.mock.calls[0]))).toContain('33334444')
  })

  it('keeps the rotation successful when the notifier is absent or unconfigured', async () => {
    // Delivery is deliberately detached: a slow or missing notifier must not
    // make an explicit security operation appear to fail.
    const handler = createRpcHandler({ tunnel: deps().maestroTunnel as never, notifier: undefined, logger: { info: vi.fn(), warn: vi.fn() } })
    const res: any = await handler('maestro.rotatePin', {})
    expect(res.ok).toBe(true)
    expect(res.value).toEqual({ pin: '33334444' })
  })

  it('lanPin.rotate delegates to rotateLanPin', async () => {
    const { handler, maestroTunnel } = deps()
    const res: any = await handler('maestro.lanPin.rotate', {})
    expect(maestroTunnel.rotateLanPin).toHaveBeenCalled()
    expect(res.value).toEqual({ pin: '77778888' })
  })

  it('lanPin.status reports disabled without generating a PIN', async () => {
    const { handler, maestroTunnel } = deps()
    const res: any = await handler('maestro.lanPin.status', {})
    expect(res.value).toEqual({ enabled: false })
    // The gate is opt-in, so an untouched install must not mint a PIN on read.
    expect(maestroTunnel.getLanPin).not.toHaveBeenCalled()
  })

  it('lanPin.status reads the PIN once the gate is on', async () => {
    const { handler, maestroTunnel } = deps()
    await handler('maestro.saveConfig', { lanPinEnabled: true })
    maestroTunnel.getLanPin.mockClear()
    const res: any = await handler('maestro.lanPin.status', {})
    expect(maestroTunnel.getLanPin).toHaveBeenCalled()
    expect(res.value).toEqual({ enabled: true, pin: '55556666' })
  })

  it('lanPin.setEnabled persists the gate, reloads the proxy and reports requiresRestart', async () => {
    const { handler, maestroTunnel } = deps()
    const res: any = await handler('maestro.lanPin.setEnabled', { enabled: true })
    expect(res.value).toMatchObject({ enabled: true, requiresRestart: true })
    expect(maestroTunnel.reloadConfig).toHaveBeenCalled()
  })
})