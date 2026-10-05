import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REMOTE_CSS } from '../src/client/remote/styles.js'

/**
 * A style hook with no rule is a defect even when nothing looks obviously
 * broken — jsdom computes no layout, so a spec that only mounts the component
 * cannot see it. This gate asks the stylesheet to cover every control type the
 * section actually emits, and to declare the text hooks once.
 *
 * It exists because of two measured defects:
 *   - the row's box rule listed input[type="text"] and select but not
 *     input[type="password"], so a control type with no rule rendered at the UA default
 *     beside the fields around it;
 *   - a stale 12px/600 label rule sat BELOW the house 14px/400 one and won on
 *     source order at equal specificity, so the whole tab rendered at the old
 *     weight. Duplicate rules are only a defect when they compete over the
 *     same property — `[data-x-row]` and `[data-x-row]:last-of-type` are not.
 */
const entry = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/client/remote/TunnelSettings.tsx'),
  'utf8',
)

/** Every input type and select the section actually renders. */
function controlTypesEmitted(): string[] {
  const types = new Set<string>()
  for (const m of entry.matchAll(/type:\s*'(text|password|checkbox)'/g)) types.add(`input[type="${m[1]}"]`)
  if (/createElement\(\s*'select'/.test(entry)) types.add('select')
  return [...types].sort()
}

describe('dsh-maestro-remote settings stylesheet', () => {
  it('has a rule for every control type the section emits', () => {
    const emitted = controlTypesEmitted()
    expect(emitted.length, 'the section must emit at least one control').toBeGreaterThan(0)

    for (const selector of emitted) {
      expect(REMOTE_CSS, `no rule matches ${selector}`).toContain(selector)
    }
  })

  it('declares the text hooks once, so nothing wins on source order', () => {
    for (const hook of ['label', 'hint'] as const) {
      const rules = REMOTE_CSS.match(new RegExp(`\\[data-remote-${hook}\\]\\s*\\{`, 'g')) ?? []
      expect(rules.length, `duplicate [data-remote-${hook}] rule silently wins`).toBe(1)
    }
  })

  it('carries the house row values', () => {
    // 14/400 label, 12/18 tertiary hint — the reference row's values.
    expect(REMOTE_CSS).toMatch(/\[data-remote-label\]\s*\{[^}]*font-size:\s*14px[^}]*font-weight:\s*400/s)
    expect(REMOTE_CSS).toMatch(/\[data-remote-hint\]\s*\{[^}]*font-size:\s*12px[^}]*line-height:\s*18px/s)
  })

  it('holds every row control to the same box', () => {
    // Collect the CONTROL rules that give a control its box, and assert their
    // combined selector list covers every non-checkbox control the section
    // emits, all at one geometry. A type missing from that list is exactly what
    // rendered the two secret fields at the UA default: 21px tall, no radius.
    const boxRules = [...REMOTE_CSS.matchAll(/(\[data-remote-control\][^{}]*)\{([^}]*min-height:\s*32px[^}]*)\}/g)]
    expect(boxRules.length, 'no control box rule found').toBeGreaterThan(0)
    const selectors = boxRules.map((m) => m[1]!).join(' , ')
    for (const type of controlTypesEmitted()) {
      if (type === 'input[type="checkbox"]') continue
      expect(selectors, type + ' is in no 32px box rule').toContain(type)
    }
    for (const m of boxRules) {
      expect(m[2]!, 'a 32px control rule without an 8px radius').toMatch(/border-radius:\s*8px/)
    }
  })

  it('gives the checkbox the harness size, not the UA default', () => {
    // Measured 13x13 on the live dialog without this rule; the reference row
    // draws 16x16 with the brand accent.
    expect(REMOTE_CSS).toMatch(/input\[type="checkbox"\]\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s)
  })
})