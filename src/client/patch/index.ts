/**
 * dsh-maestro-patch — client half.
 * Zero-fork shim: viewport, apple-touch-icon link, trusted-proxy isLoopback, welcome-store.
 */

import { installViewportPatch } from './patches/viewport.js'
import { installAppleIcon } from './patches/apple-icon.js'
import { patchConnectionIsLoopback } from './patches/connection.js'
import { installWelcomePatch } from './patches/welcome.js'

export interface ClientContext {
  effect(install: () => unknown, label?: string): unknown
  get(service: string): unknown
}

export function apply(ctx: ClientContext): void {
  // E — welcome store prototype patch at load time (before any instance)
  try { installWelcomePatch() } catch {}

  ctx.effect(() => installViewportPatch(), 'maestro-patch:viewport')
  ctx.effect(() => installAppleIcon(), 'maestro-patch:apple-icon')
  patchConnectionIsLoopback(ctx as never)
}
