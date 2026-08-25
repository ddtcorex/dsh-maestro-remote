import * as React from 'react'

/**
 * Settings QR card placeholder for dsh-maestro-remote.
 * Host provides /maestro/remote RPC (status/rotatePin/qr).
 * This client registers a Settings card via dsh-client-ui-slots.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const inject = ctx.slots?.inject
    if (!inject) return () => {}
    const dispose = inject('settings', () => {
      return React.createElement('div', { 'data-maestro-remote-settings': 'qr-card', style: { padding: '12px', border: '1px solid var(--dsh-border, #ddd)', borderRadius: '8px' } },
        React.createElement('h3', { style: { margin: '0 0 8px 0', fontSize: '14px' } }, 'Maestro Remote'),
        React.createElement('p', { style: { margin: '0 0 8px 0', fontSize: '12px', opacity: 0.7 } }, 'QR access — scan to open remote URL. PIN-gated proxy on :3081 / Cloudflare tunnel.'),
        React.createElement('div', { 'data-maestro-remote-qr-placeholder': 'true', style: { width: '160px', height: '160px', background: '#f5f5f5', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: '#999' } }, 'QR placeholder'),
        React.createElement('button', {
          onClick: async () => {
            try { await ctx.connection?.rpc?.call('/maestro/remote', { endpoint: 'status' }) } catch {}
          },
          style: { marginTop: '8px', padding: '6px 10px', fontSize: '12px' }
        }, 'Check status')
      )
    })
    return () => { try { dispose?.() } catch {} }
  })
}

export default { apply }
