/**
 * The `tunnel` domain is remote's, but until now NOTHING validated it except
 * one RPC handler, and only on the keys that handler happened to know.
 *
 * The store accepts a write to an unregistered domain as-is by design, and
 * remote registered no validator at all. So every OTHER path that reaches the
 * shared file wrote `domains.tunnel` unchecked: `maestro.lanPin.setEnabled`
 * (bypasses the SAVABLE set entirely, which is correct — `lanPinEnabled` is
 * deliberately not savable from the Settings card — and therefore also
 * unvalidated), the tunnel-profile applier after a harness sync, and any future
 * caller. A bad value lands in the file that the proxy, the cloudflared
 * controller and the PIN gate all read at boot.
 *
 * `defineDomain` validates the MERGED domain on every write, so the validator
 * has to accept a whole `tunnel` object, not just a patch. It therefore checks
 * the same fields `saveTunnelConfig` checks, plus `lanPinEnabled`, and stays
 * silent about keys it does not own so a foreign writer is not blocked by this
 * plugin's rules.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { definedDomains, load, set } from '../src/host/vendor/store.js'
import { tunnelValidator } from '../src/host/tunnel-validator.js'
import '../src/host/tunnel-validator.js'

describe('tunnel domain validator', () => {
  it('registers the tunnel domain with the store', () => {
    expect(definedDomains()).toContain('tunnel')
  })

  it('accepts a well-formed tunnel domain', () => {
    expect(
      tunnelValidator.parse({
        mode: 'public',
        quickTarget: 'tunnel.example.invalid',
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        hostname: 'tunnel.example.invalid',
        credentialsFile: '/srv/secrets/aaaaaaaa-credentials.json',
        proxyPort: 3081,
        proxyHost: '127.0.0.1',
        lanPinEnabled: true,
        pinSessionTtlHours: 12,
      }),
    ).toEqual({ ok: true })
  })

  it('rejects a non-object domain', () => {
    expect(tunnelValidator.parse('nope').ok).toBe(false)
    expect(tunnelValidator.parse([]).ok).toBe(false)
  })

  it('rejects a non-boolean lanPinEnabled', () => {
    expect(tunnelValidator.parse({ lanPinEnabled: 'yes' }).ok).toBe(false)
    expect(tunnelValidator.parse({ lanPinEnabled: 1 }).ok).toBe(false)
  })

  it('rejects an out-of-range or fractional proxyPort', () => {
    expect(tunnelValidator.parse({ proxyPort: 70000 }).ok).toBe(false)
    expect(tunnelValidator.parse({ proxyPort: -1 }).ok).toBe(false)
    expect(tunnelValidator.parse({ proxyPort: 1.5 }).ok).toBe(false)
  })

  it('accepts proxyPort 0, which asks the OS for a free port', () => {
    expect(tunnelValidator.parse({ proxyPort: 0 }).ok).toBe(true)
  })

  it('rejects a negative or fractional pinSessionTtlHours', () => {
    expect(tunnelValidator.parse({ pinSessionTtlHours: -1 }).ok).toBe(false)
    expect(tunnelValidator.parse({ pinSessionTtlHours: 1.5 }).ok).toBe(false)
    expect(tunnelValidator.parse({ pinSessionTtlHours: 0 }).ok).toBe(true)
  })

  it('rejects a tunnel id that is not a UUID', () => {
    expect(tunnelValidator.parse({ id: 'dsh-home' }).ok).toBe(false)
    expect(
      tunnelValidator.parse({ id: 'a6a31b92-1111-2222-3333-444455556666' }).ok,
    ).toBe(true)
  })

  it('says which key was wrong', () => {
    const result = tunnelValidator.parse({ proxyPort: 70000 })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('proxyPort')
  })

  it('ignores keys it does not own', () => {
    expect(tunnelValidator.parse({ someOtherPluginKey: { deep: true } }).ok).toBe(true)
  })

  it('blocks a bad write through the store, not only through the validator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-tunnel-'))
    await set('tunnel', { proxyPort: 3081 }, { dshHome: dir })

    await expect(set('tunnel', { proxyPort: 70000 }, { dshHome: dir })).rejects.toThrow(/proxyPort/)

    const doc = await load({ dshHome: dir })
    expect((doc.domains.tunnel as { proxyPort?: unknown }).proxyPort).toBe(3081)
  })
})