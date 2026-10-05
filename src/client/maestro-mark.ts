/**
 * Maestro M logo — the react-free half of this package's copy.
 *
 * This is a verbatim copy of
 * `dsh-maestro-core/src/client/config/maestro-mark.ts`, which is the source of
 * record for the house pattern. The duplication is structural, not accidental:
 * every Maestro package declares its own `dsh.client` entry and builds its own
 * `lib/client.js`, so one plugin's client module cannot import another's.
 *
 * The react half lives in `BrandMark.tsx` and cannot be imported from vitest at
 * all — `react` is a client-bundler EXTERNAL with no entry in this package's
 * `package.json`. Splitting the glyph declaration out is what lets a test assert
 * these exact bytes instead of grepping source text.
 */

export const MAESTRO_MARK_PATH = 'M2 11 L5 4 L8 9 L11 4 L14 11'
export const MAESTRO_MARK_VIEWBOX = '0 0 16 16'
export const MAESTRO_MARK_STROKE_WIDTH = 1.6

/** Badge tile colour — part of the house pattern documented in AGENTS.md. */
export const MAESTRO_BRAND_TILE = '#0A84FF'