import { describe, it, expect } from 'vitest'
import { injectPolyfill } from '../src/host/remote-proxy.ts'

const HEAD_HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'

describe('injectPolyfill: loopback transport marker', () => {
  it('injects a script declaring ownsHost so remote pages get host-backed settings', () => {
    const out = injectPolyfill(HEAD_HTML)
    expect(out).toContain('data-maestro-loopback-transport')
    expect(out).toContain('ownsHost:true')
    // It must land inside <head>, before any app bundle script can read the global.
    expect(out.indexOf('data-maestro-loopback-transport')).toBeGreaterThan(out.indexOf('<head>'))
    expect(out.indexOf('data-maestro-loopback-transport')).toBeLessThan(out.indexOf('</head>'))
  })

  it('preserves an existing transport global (does not blind-overwrite hooks)', () => {
    const out = injectPolyfill(HEAD_HTML)
    expect(out).toMatch(/Object\.assign\(globalThis\.__DSH_TRANSPORT__\|\|\{\},\{ownsHost:true\}\)/)
  })

  it('never injects the marker twice', () => {
    const once = injectPolyfill(HEAD_HTML)
    const twice = injectPolyfill(once)
    expect(twice.match(/data-maestro-loopback-transport/g)).toHaveLength(1)
  })
})