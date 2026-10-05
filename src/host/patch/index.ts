/**
 * dsh-maestro-patch — host half.
 * Zero-fork shim: patches BlockAssembler and serves apple-touch-icon.
 */

import { patchAssembler } from './patches/assembler.js'

export interface HostContext {
  effect(install: () => unknown, label?: string): unknown
  get?(service: string): unknown
}

export function apply(ctx: HostContext): void {
  ctx.effect(() => patchAssembler(ctx), 'maestro-patch:assembler')
}
