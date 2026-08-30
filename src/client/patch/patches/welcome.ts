/**
 * Patch WelcomeNoticeStore to persist acknowledgment via localStorage for remote memory-mode.
 * Feature-detects upstream: if getter already reads localStorage, no-ops.
 * Works in both Node (tests) and browser (DSH client).
 */

const WELCOME_VERSION_FALLBACK = '2026-08-13.1'

function patchPrototype(WelcomeNoticeStore: { prototype: Record<string, unknown> }, version: string): void {
  const desc = Object.getOwnPropertyDescriptor(WelcomeNoticeStore.prototype, 'localAcknowledged')
  if (desc?.get && String(desc.get).includes('localStorage')) return

  Object.defineProperty(WelcomeNoticeStore.prototype, 'localAcknowledged', {
    get(): boolean {
      try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('dsh-welcome-acknowledged') === version
      } catch {
        return false
      }
    },
    set(_value: boolean): void {
      try {
        if (typeof localStorage === 'undefined') return
        if (_value) localStorage.setItem('dsh-welcome-acknowledged', version)
        else localStorage.removeItem('dsh-welcome-acknowledged')
      } catch {}
    },
    configurable: true,
  })
}

export function installWelcomePatch(): void {
  // Try synchronous require (Node / vitest)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require('@deepseek-ai/dsh-client-ui-settings-models/src/client/welcome-store.js') as { WelcomeNoticeStore?: { prototype: Record<string, unknown> } }
    if (m.WelcomeNoticeStore) {
      let version = WELCOME_VERSION_FALLBACK
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const copy = require('@deepseek-ai/dsh-client-ui-settings-models/src/onboarding-copy.js') as { WELCOME_NOTICE_VERSION?: string }
        if (copy.WELCOME_NOTICE_VERSION) version = copy.WELCOME_NOTICE_VERSION
      } catch {}
      patchPrototype(m.WelcomeNoticeStore, version)
      return
    }
  } catch {}

  // Browser: try dynamic import (fire-and-forget, patch when loaded)
  try {
    const doImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>
    void doImport('@deepseek-ai/dsh-client-ui-settings-models/src/client/welcome-store.js')
      .then((m) => {
        const mod = m as { WelcomeNoticeStore?: { prototype: Record<string, unknown> } }
        if (!mod.WelcomeNoticeStore) return
        let version = WELCOME_VERSION_FALLBACK
        void doImport('@deepseek-ai/dsh-client-ui-settings-models/src/onboarding-copy.js')
          .then((c) => {
            const copy = c as { WELCOME_NOTICE_VERSION?: string }
            if (copy.WELCOME_NOTICE_VERSION) version = copy.WELCOME_NOTICE_VERSION
            patchPrototype(mod.WelcomeNoticeStore as { prototype: Record<string, unknown> }, version)
          })
          .catch(() => patchPrototype(mod.WelcomeNoticeStore as { prototype: Record<string, unknown> }, version))
      })
      .catch(() => {})
  } catch {}
}
