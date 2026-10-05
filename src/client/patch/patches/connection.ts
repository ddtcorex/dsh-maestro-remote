export function patchConnectionIsLoopback(ctx: { get: (k: string) => { isLoopback: boolean } | undefined; effect: (fn: () => unknown, label?: string) => unknown }): unknown {
  return ctx.effect(() => {
    const conn = ctx.get('connection')
    if (!conn) return
    const trusted = (globalThis as { __DSH_TRUSTED_PROXY__?: true }).__DSH_TRUSTED_PROXY__ === true
    if (trusted && !conn.isLoopback) {
      const orig = conn.isLoopback
      Object.defineProperty(conn, 'isLoopback', { value: true, writable: true, configurable: true })
      return () => Object.defineProperty(conn, 'isLoopback', { value: orig, writable: true, configurable: true })
    }
  }, 'maestro-patch:trusted-proxy')
}
