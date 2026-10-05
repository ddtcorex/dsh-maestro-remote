import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The Public hostname field, end to end against the real shared store.
 *
 * The defect this pins: `maestro.saveConfig` whitelisted the store's FLAT
 * aliases (`tunnelHostname`) while `maestro.getConfig` answered the raw NESTED
 * domain (`hostname`). A client could therefore not save the key it had just
 * been handed, and one that sent the alias stored
 * `domains.tunnel.tunnelHostname` — a key nothing reads back. The field
 * rendered empty while the tunnel served a hostname the whole time.
 *
 * The round trip matters because the host reads the FLAT view: `tunnel.ts`
 * consumes `userConfig.tunnelHostname`, which `readFlat` produces from
 * `domains.tunnel.hostname`. Writing `hostname` must therefore surface as
 * `tunnelHostname` to the tunnel, or this test passes while the field still
 * does nothing.
 *
 * DSH_HOME is pinned for every write. The store resolves
 * `DSH_HOME ?? ~/.dsh` per call and `set()` deep-merges, so a test that
 * forgets it silently overwrites the operator's real settings.
 */
const created: string[] = []
let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-hostname-'))
  created.push(home)
  process.env.DSH_HOME = home
  // Every copy of the store resolves DSH_HOME per call, so a module loaded in a
  // previous file still sees this value.
})

afterEach(() => {
  delete process.env.DSH_HOME
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('tunnel hostname round trip', () => {
  it('writes hostname and reads it back as the flat alias the tunnel consumes', async () => {
    const { createRpcHandler } = await import('../src/host/rpc.js')
    const { loadUserConfig } = await import('../src/host/config-store.js')

    const handler = createRpcHandler({
      tunnel: {
        status: () => ({ running: false, phase: 'idle' }),
        start: async () => ({}), stop: async () => ({}), proxyStatus: () => ({}),
        reloadConfig: async () => {},
        getPin: async () => '12345678', rotatePin: async () => '12345678',
        getLanPin: async () => '', rotateLanPin: async () => '',
      } as any,
    })

    const saved: any = await handler('maestro.saveConfig', { hostname: 'tunnel.example.com' })
    expect(saved.ok, JSON.stringify(saved)).toBe(true)

    // getConfig answers the nested key the client wrote.
    const read: any = await handler('maestro.getConfig', {})
    expect(read.ok).toBe(true)
    expect(read.value.hostname).toBe('tunnel.example.com')
    expect(read.value.tunnelHostname).toBeUndefined()

    // The tunnel consumes the FLAT view, which readFlat builds from
    // `tunnel.hostname`. This is the assertion that would fail if the write
    // landed under the alias.
    const cfg = await loadUserConfig()
    expect(cfg.tunnelHostname).toBe('tunnel.example.com')
  })

  it('never writes the flat alias into the domain', async () => {
    const { createRpcHandler } = await import('../src/host/rpc.js')
    const handler = createRpcHandler({
      tunnel: {
        status: () => ({ running: false, phase: 'idle' }),
        start: async () => ({}), stop: async () => ({}), proxyStatus: () => ({}),
        reloadConfig: async () => {},
        getPin: async () => '', rotatePin: async () => '',
        getLanPin: async () => '', rotateLanPin: async () => '',
      } as any,
    })

    await handler('maestro.saveConfig', { tunnelHostname: 'wrong.example.com' })

    const read: any = await handler('maestro.getConfig', {})
    expect(read.value.hostname).toBeUndefined()
    expect(read.value.tunnelHostname).toBeUndefined()
  })
})