import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/index.tsx'), 'utf8')

describe('maestro-remote settings section', () => {
  it('declares id maestro-remote at order 31', () => {
    // 31 is the number the shell sorts by alone. 25 belongs to upstream's
    // archived-sessions page and 26-29 are the Maestro block, so the new
    // owners continue at 31 and Sutunam stays last at 40.
    expect(entry).toMatch(/id:\s*'maestro-remote'[\s\S]{0,400}?order:\s*31/)
  })

  it('never reuses an order another section already claims', () => {
    for (const taken of [25, 26, 27, 28, 29, 32, 33, 40]) {
      expect(entry, `order ${taken}`).not.toMatch(new RegExp(`order:\\s*${taken}\\b`))
    }
  })

  it('leaves the settings-nav glyph to the shell', () => {
    // DSH 0.2.x renders a section row as `button > span.navIcon > svg` through
    // the settings.section.icon slot, with the gear as fallback. The 0.1.x
    // marker + ::before mask hid nothing there, so the row painted the injected
    // M beside the shell's gear. The default gear is the icon now.
    expect(entry).not.toContain('registerSettingsNavIcon')
    expect(entry).not.toContain('settings-nav')
    expect(existsSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/settings-nav-icon.ts'))).toBe(false)
  })

  it('serves only this package own channel', () => {
    expect(entry).toContain('/dsh-maestro-remote')
    expect(entry).not.toContain('/maestro-reviewer')
  })

  it('registers exactly one section', () => {
    expect(entry.match(/id:\s*'maestro-remote'/g)?.length ?? 0).toBe(1)
  })
})