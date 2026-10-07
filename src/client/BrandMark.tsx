/**
 * The Maestro M badge this package's settings header draws.
 *
 * A copy of `dsh-maestro-core/src/client/config/components/BrandMark.tsx`, for
 * the structural reason its own header explains: one plugin's client bundle
 * cannot import another's. The glyph and tile come from `./maestro-mark.ts`.
 */

import { createElement as h } from 'react'
import {
  MAESTRO_BRAND_TILE,
  MAESTRO_MARK_PATH,
  MAESTRO_MARK_STROKE_WIDTH,
  MAESTRO_MARK_VIEWBOX,
} from './maestro-mark.js'

function MaestroMark(props: { size?: number }) {
  const s = props.size ?? 16
  return h('svg', { width: s, height: s, viewBox: MAESTRO_MARK_VIEWBOX, fill: 'none', 'aria-hidden': 'true' } as any,
    h('path', { d: MAESTRO_MARK_PATH, stroke: 'currentColor', strokeWidth: MAESTRO_MARK_STROKE_WIDTH, strokeLinecap: 'round', strokeLinejoin: 'round' } as any),
  )
}

/**
 * The 28px brand tile. Its colour, border, shadow and radius are the brand and
 * are not negotiable — a token-only background resolves to near-white on some
 * dark themes, which is why the fixed tile exists.
 */
export function BrandBadge(props: { size?: number; outer?: number; radius?: number; style?: Record<string, unknown> }) {
  const outer = props.outer ?? 28
  const size = props.size ?? 16
  const radius = props.radius ?? 8
  return h('span', {
    'data-maestro-logo': '',
    style: {
      width: outer, height: outer, borderRadius: radius, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: `var(--dsw-alias-brand-primary, ${MAESTRO_BRAND_TILE})`, backgroundColor: MAESTRO_BRAND_TILE, color: '#fff', flex: 'none',
      border: '1px solid rgba(0,0,0,0.08)', boxShadow: '0 0 0 1px var(--dsw-alias-border-l1)', boxSizing: 'border-box' as any,
      ...props.style,
    },
  } as any, h(MaestroMark as any, { size }))
}