import { defineDomain, type DomainValidator } from './vendor/store.js'

/** Cloudflare tunnel ids are UUIDs; a name like `dsh-home` is not one. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error })

/**
 * Schema for the `tunnel` domain, which this plugin owns in the shared store.
 *
 * The store accepts a write to an unregistered domain as-is, by design, and
 * this plugin registered no validator. So the only checks that ever ran were
 * the ones in `rpc.ts`'s `saveTunnelConfig`, and they ran on ONE path: a client
 * posting settings. `maestro.lanPin.setEnabled` writes the domain directly
 * (correctly — `lanPinEnabled` is deliberately not savable from the Settings
 * card, which is why it is not in `SAVABLE`), and the tunnel-profile applier
 * rewrites the whole domain after every harness sync. Neither was checked.
 *
 * `defineDomain` receives the domain as it will be AFTER the patch is merged,
 * so every key is optional here and an absent key is never an error — only a
 * present key of the wrong shape is. Keys this plugin does not own are left
 * alone: another writer's value must not be rejected by these rules.
 */
export const tunnelValidator: DomainValidator = {
  parse(value: unknown) {
    if (value == null) return { ok: true }
    if (typeof value !== 'object' || Array.isArray(value)) {
      return bad('tunnel must be an object')
    }
    const v = value as Record<string, unknown>

    if (v.mode !== undefined && v.mode !== null && typeof v.mode !== 'string') {
      return bad('tunnel.mode must be a string')
    }
    if (v.id !== undefined && v.id !== null && v.id !== '' && !UUID_RE.test(String(v.id))) {
      return bad('tunnel.id must be a tunnel UUID')
    }
    if (v.hostname !== undefined && v.hostname !== null && typeof v.hostname !== 'string') {
      return bad('tunnel.hostname must be a string')
    }
    if (v.credentialsFile !== undefined && v.credentialsFile !== null && typeof v.credentialsFile !== 'string') {
      return bad('tunnel.credentialsFile must be a string')
    }
    if (v.quickTarget !== undefined && v.quickTarget !== null && typeof v.quickTarget !== 'string') {
      return bad('tunnel.quickTarget must be a string')
    }
    if (v.proxyHost !== undefined && v.proxyHost !== null && typeof v.proxyHost !== 'string') {
      return bad('tunnel.proxyHost must be a string')
    }
    if (v.lanPinEnabled !== undefined && v.lanPinEnabled !== null && typeof v.lanPinEnabled !== 'boolean') {
      return bad('tunnel.lanPinEnabled must be a boolean')
    }
    if (v.proxyPort !== undefined && v.proxyPort !== null) {
      // 0 is meaningful: it asks the OS for a free port (the LAN boot tests and
      // the ephemeral dry-boot rely on it), so the range is 0..65535 and only a
      // non-integer or an out-of-range value is refused.
      const port = Number(v.proxyPort)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return bad('tunnel.proxyPort must be an integer between 0 and 65535')
      }
    }
    if (v.pinSessionTtlHours !== undefined && v.pinSessionTtlHours !== null) {
      // The ceiling is the proxy's own constant and is deliberately generous;
      // what this domain must reject is a value the proxy would silently clamp
      // or misread — a negative or fractional hour count.
      const ttl = Number(v.pinSessionTtlHours)
      if (!Number.isInteger(ttl) || ttl < 0) {
        return bad('tunnel.pinSessionTtlHours must be a non-negative integer')
      }
    }
    return { ok: true }
  },
}

/** Side-effect import: this module IS the registration for the `tunnel` domain. */
try { defineDomain('tunnel', tunnelValidator) } catch {}