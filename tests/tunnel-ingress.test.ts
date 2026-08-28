import { describe, it, expect } from 'vitest'
import { writeNamedTunnelConfig } from '../src/host/tunnel.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
describe('tunnel ingress single rule', () => {
  it('writes single ingress on webServer port, no webhookPort', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-'))
    const p = await writeNamedTunnelConfig({ dshHome, tunnelId: 'tid', credentialsFile: '/tmp/creds.json', hostname: 'h.example.com', proxyPort: 3080 } as any)
    const c = readFileSync(p, 'utf8')
    expect(c).toContain('service: http://127.0.0.1:3080')
    expect(c).not.toContain('webhookPort')
    expect((c.match(/service:/g)||[]).length).toBe(2) // one for hostname, one 404 fallback — or 1 + 404
  })
})
