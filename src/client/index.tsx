/**
 * dsh-maestro-remote — client bundle entry.
 *
 * Two modules share this bundle after absorbing dsh-maestro-patch:
 *   - the patch shim (viewport, apple-touch-icon, connection loopback, welcome),
 *     which must install its welcome prototype at load time, before anything
 *     else renders;
 *   - the `settings.section` id `maestro-remote` (order 31), Tunnel and LAN.
 *
 * Each apply is wrapped in its own try/catch so one broken surface cannot cost
 * the other its registration: a settings card that throws on mount must not
 * also take the viewport patch down with it.
 */
import * as React from 'react'
import { apply as applyPatch } from './patch/index.js'
import { TunnelSettings } from './remote/TunnelSettings.js'
import { REMOTE_CSS } from './remote/styles.js'

/** This package's own channel; the endpoints it serves. */
const REMOTE_CHANNEL = '/dsh-maestro-remote'

export type RpcCall = (endpoint: string, payload?: unknown) => Promise<any>

/**
 * Unwrap the `RpcResult` envelope. A bare `{ ok: true }` is not a usable
 * answer: the value is what the form renders, so an endpoint that forgets it
 * produces an empty card that saves nothing and reports no error.
 */
function unwrap(res: any): any {
  return res && typeof res === 'object' && 'ok' in res ? (res.ok ? res.value : null) : res
}

function makeRpcCall(ctx: any): RpcCall {
  return async (endpoint, payload) => {
    const conn = ctx.get?.('connection')
    if (conn?.rpc?.call === undefined) throw new Error('RPC not available')
    const res = await conn.rpc.call(REMOTE_CHANNEL, endpoint, payload ?? {})
    const value = unwrap(res)
    if (value === null) {
      throw new Error(String(res?.error?.message ?? res?.error ?? endpoint))
    }
    return value
  }
}

function installStyleTag(css: string, pluginCss: string): () => void {
  if (typeof document === 'undefined') return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = '@ddtcorex/dsh-maestro-remote'
  tag.dataset.pluginCss = pluginCss
  tag.textContent = css
  document.head.appendChild(tag)
  return () => {
    document.querySelector(`style[data-plugin-css="${pluginCss}"]`)?.remove()
  }
}

export const inject = ['slots', 'connection'] as const

const MODULES = [
  ['patch', applyPatch],
  ['remote', applySettings],
] as const

/** Guarded so one module failing cannot cost the other its registration. */
function applySettings(ctx: any): void {
  const slots = ctx.get?.('slots')
  if (!slots?.inject || !slots?.register) return

  const rpcCall = makeRpcCall(ctx)

  ctx.effect(() => installStyleTag(REMOTE_CSS, 'maestro-remote/settings.css'), 'maestro-remote: settings css')

  ctx.effect(() => {
    const dispose = slots.inject('settings.section', () =>
      slots.register(
        {
          name: 'settings.section',
          id: 'maestro-remote',
          order: 31,
          label: () => 'Maestro Remote',
          inject: () => ({ rpcCall }),
        },
        (props: { rpcCall: RpcCall }) => React.createElement(TunnelSettings, props),
      ),
    )
    return () => {
      try {
        ;(dispose as any)?.()
      } catch {
        // Teardown must never throw.
      }
    }
  }, 'maestro-remote: settings')
}

export function apply(ctx: any): void {
  for (const [name, register] of MODULES) {
    try {
      register(ctx)
    } catch (err) {
      console.error(`[dsh-maestro-remote] ${name} client module failed to apply`, err)
    }
  }
}

export default { inject, apply }