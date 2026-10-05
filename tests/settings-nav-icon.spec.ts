import { describe, expect, it, vi } from 'vitest'
import { registerSettingsNavIcon, SETTINGS_NAV_MARKER } from '../src/client/settings-nav-icon.js'

/**
 * The settings nav row identifies itself by a marker attribute, because DSH
 * projects only id/order/label from a `settings.section` registration and takes
 * icons from a closed built-in list — there is no icon field to fill.
 *
 * The marker has to be this package's OWN. `registerSettingsNavIcon` clears its
 * marker from every row that is not its own section, so two plugins sharing one
 * marker name fight over the same attribute and only the last `sync()` survives:
 * on the live profile four wave-2 sections shipped the identical name copied
 * from gateway, three lost their icon, and nothing logged.
 */
/** A stand-in for a nav button: just the three attribute methods used here. */
function row(text: string, attrs: Array<[string, string]> = []) {
  const map = new Map(attrs)
  return {
    textContent: text,
    setAttribute: (n: string, v: string) => { map.set(n, v) },
    removeAttribute: (n: string) => { map.delete(n) },
    hasAttribute: (n: string) => map.has(n),
    attrs: map,
  }
}

describe('settings nav marker', () => {
  it('is this package’s own, not a shared one', () => {
    // Copied verbatim from dsh-maestro-gateway by whoever added the file.
    expect(SETTINGS_NAV_MARKER).toBe('data-maestro-remote-settings-nav')
  })

  it('marks its own row and leaves another marker alone', () => {
    const rows = [
      row('Maestro Remote'),
      // A row another plugin owns, carrying that plugin's marker.
      row('Maestro Jobs', [['data-maestro-jobs-settings-nav', '']]),
    ]
    const root = {
      querySelectorAll: (selector: string) => {
        if (selector === '[role="dialog"] nav button') return rows as any
        if (selector === `[${SETTINGS_NAV_MARKER}]`) {
          return rows.filter((r) => r.attrs.has(SETTINGS_NAV_MARKER)) as any
        }
        return [] as any
      },
    }

    const dispose = registerSettingsNavIcon(() => 'Maestro Remote', root as any)

    expect(rows[0]!.attrs.get(SETTINGS_NAV_MARKER)).toBe('')
    // The point of the bug: a foreign marker must survive untouched.
    expect(rows[1]!.attrs.has('data-maestro-jobs-settings-nav')).toBe(true)
    expect(rows[1]!.attrs.has(SETTINGS_NAV_MARKER)).toBe(false)

    dispose()
    expect(rows[0]!.attrs.has(SETTINGS_NAV_MARKER)).toBe(false)
  })

  it('clears its own marker when the row no longer matches', () => {
    const rows = [row('Renamed', [[SETTINGS_NAV_MARKER, '']])]
    const root = {
      querySelectorAll: (selector: string) => {
        if (selector === '[role="dialog"] nav button') return rows as any
        if (selector === `[${SETTINGS_NAV_MARKER}]`) {
          return rows.filter((r) => r.attrs.has(SETTINGS_NAV_MARKER)) as any
        }
        return [] as any
      },
    }

    registerSettingsNavIcon(() => 'Maestro Remote', root as any)

    expect(rows[0]!.attrs.has(SETTINGS_NAV_MARKER)).toBe(false)
  })

  it('is a no-op without a document', () => {
    // Node-side import safety: the host half imports this module.
    const spy = vi.fn()
    expect(() => registerSettingsNavIcon(() => 'Maestro Remote')).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })
})