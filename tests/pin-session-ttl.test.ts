import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PIN_SESSION_TTL_HOURS,
  MAX_PIN_SESSION_TTL_HOURS,
  resolvePinSessionTtlHours,
  pinSessionCookie,
} from '../src/host/remote-proxy.ts'

describe('resolvePinSessionTtlHours', () => {
  it('uses the product default when the setting is absent', () => {
    expect(DEFAULT_PIN_SESSION_TTL_HOURS).toBe(24)
    expect(resolvePinSessionTtlHours(undefined)).toBe(24)
    expect(resolvePinSessionTtlHours(null)).toBe(24)
  })

  it('treats zero and negatives as session-only', () => {
    expect(resolvePinSessionTtlHours(0)).toBe(0)
    expect(resolvePinSessionTtlHours(-5)).toBe(0)
  })

  it('fails closed on unusable values instead of granting a long session', () => {
    for (const bad of ['24', '', Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) {
      expect(resolvePinSessionTtlHours(bad)).toBe(0)
    }
  })

  it('accepts and rounds positive values', () => {
    expect(resolvePinSessionTtlHours(1)).toBe(1)
    expect(resolvePinSessionTtlHours(168)).toBe(168)
    expect(resolvePinSessionTtlHours(1.5)).toBe(2)
    expect(resolvePinSessionTtlHours(0.4)).toBe(0)
  })

  it('clamps above the maximum', () => {
    expect(MAX_PIN_SESSION_TTL_HOURS).toBe(8760)
    expect(resolvePinSessionTtlHours(8760)).toBe(8760)
    expect(resolvePinSessionTtlHours(1e9)).toBe(8760)
  })
})

describe('pinSessionCookie', () => {
  it('always keeps the hardened attributes and the bare PIN value', () => {
    const cookie = pinSessionCookie('12345678', 24)
    expect(cookie.startsWith('maestro_pin=12345678;')).toBe(true)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    // No Secure attribute: the LAN listener serves plain HTTP (see spec D7).
    expect(cookie).not.toContain('Secure')
  })

  it('adds Max-Age and a matching Expires for a positive lifetime', () => {
    const before = Date.now()
    const cookie = pinSessionCookie('12345678', 24)
    expect(cookie).toContain('Max-Age=86400')
    const expires = /Expires=([^;]+)/.exec(cookie)?.[1]
    expect(expires).toBeDefined()
    const at = new Date(String(expires)).getTime()
    expect(at).toBeGreaterThanOrEqual(before + 86_400_000 - 5_000)
    expect(at).toBeLessThanOrEqual(before + 86_400_000 + 5_000)
    expect(pinSessionCookie('12345678', 1)).toContain('Max-Age=3600')
    expect(pinSessionCookie('12345678', 168)).toContain('Max-Age=604800')
  })

  it('emits a session cookie (no Max-Age, no Expires) for zero', () => {
    const cookie = pinSessionCookie('12345678', 0)
    expect(cookie).toBe('maestro_pin=12345678; HttpOnly; SameSite=Lax; Path=/')
  })
})
