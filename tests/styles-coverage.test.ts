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

/** Block comments stripped, so prose above a rule can never satisfy an assertion. */
const stripped = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * The field rule whose selector list starts with `prefix` and which styles a
 * form control: both its SELECTOR and its declaration body.
 *
 * Both are returned because they answer different questions and an assertion
 * aimed at the wrong one is silently unfalsifiable. `input[type="checkbox"]` is
 * a SELECTOR token — a declaration body can never contain it — so a check like
 * `expect(body).not.toContain('input[type="checkbox"]')` passes no matter what
 * the selector says. That is how the checkbox leaked into the field box here
 * with the suite still green.
 *
 * Scoping to this rule also stops an unrelated rule elsewhere in the sheet from
 * satisfying an assertion about the field box.
 */
function fieldRule(css: string, prefix: string): { selector: string; body: string } {
  const source = stripped(css)
  const pattern = new RegExp(`(${prefix.replace(/[[\]]/g, '\\$&')}[^{}]*(?:input|select|textarea)[^{}]*)\\{([^{}]*)\\}`, 'g')
  for (const m of source.matchAll(pattern)) {
    if (m[2]!.includes('min-height')) return { selector: m[1]!, body: m[2]! }
  }
  return { selector: '', body: '' }
}

/** Just the field rule's declaration body. */
function fieldRuleBody(css: string, prefix: string): string {
  return fieldRule(css, prefix).body
}

/**
 * The shared settings field box, copied from the host's own form primitive
 * (`ui-primitives/src/ConfigField.module.css`) plus the one Maestro-only value,
 * `min-height: 44px`, for the >=40px touch target AGENTS.md requires.
 *
 * Tokens, never resolved values: `--dsw-radius-md` must stay the token so a
 * host change reaches this plugin without editing it.
 *
 * Every property of the spec's declaration is asserted, not a subset — a
 * reverting mutation on any one of them must turn this red.
 */
const standardBox = (body: string): boolean =>
  /padding:\s*6px 12px/.test(body)
  && /border:\s*0\.5px solid var\(--dsw-alias-border-l4\)/.test(body)
  && /border-radius:\s*var\(--dsw-radius-md\)/.test(body)
  && /background:\s*var\(--dsw-alias-bg-layer-3\)/.test(body)
  && /color:\s*var\(--dsw-alias-label-primary\)/.test(body)
  && /font:\s*inherit/.test(body)
  && /min-height:\s*44px/.test(body)

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
    // `:has(...) [data-remote-control]` rules size the checkbox row's tap target, not a
    // field, so the (?<![)>] ) lookbehind keeps them out of this field-box heuristic.
    const boxRules = [...REMOTE_CSS.matchAll(/(?<![)>] )(\[data-remote-control\][^{}]*)\{([^}]*min-height:\s*44px[^}]*)\}/g)]
    expect(boxRules.length, 'no control box rule found').toBeGreaterThan(0)
    const selectors = boxRules.map((m) => m[1]!).join(' , ')
    for (const type of controlTypesEmitted()) {
      if (type === 'input[type="checkbox"]') continue
      expect(selectors, type + ' is in no 44px box rule').toContain(type)
    }
    for (const m of boxRules) {
      expect(m[2]!, 'a 44px control rule without the host radius token').toMatch(/border-radius:\s*var\(--dsw-radius-md\)/)
    }
  })

  it('gives the checkbox the harness size, not the UA default', () => {
    // Measured 13x13 on the live dialog without this rule; the reference row
    // draws 16x16 with the brand accent.
    expect(REMOTE_CSS).toMatch(/input\[type="checkbox"\]\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s)
  })

  it('every field control uses the shared settings box', () => {
    const body = fieldRuleBody(REMOTE_CSS, '[data-remote-control]')
    expect(body, 'remote fields must use the shared box from ConfigField').not.toBe('')
    expect(standardBox(body)).toBe(true)
  })

  it('the shared box never reaches the checkbox', () => {
    // The harness draws a checkbox at 16px square. A field-box rule that also
    // matched it would inflate it to 44px; the checkbox rule must stay separate.
    // Asserted on the SELECTOR, which is the only place this token can appear.
    // An earlier version checked the declaration body and could not fail.
    const { selector } = fieldRule(REMOTE_CSS, '[data-remote-control]')
    expect(selector, 'the field rule must exist').not.toBe('')
    expect(selector, 'the field box must not select the checkbox — it would inherit 44px').not.toContain('checkbox')
    expect(REMOTE_CSS).toMatch(/input\[type="checkbox"\]\s*\{[^}]*width:\s*16px/s)
  })

  it('the select shares the box rather than keeping padding of its own', () => {
    // This sheet draws no custom arrow (no appearance:none, no background-image),
    // so the UA reserves its own space and the shared padding applies unchanged.
    // A padding override would be a second geometry.
    //
    // The selector must be matched the same way fieldRuleBody matches it: a bare
    // `\[data-remote-control\][^{}]*` also matches the row container
    // `[data-remote-control] { ... min-height: 36px }`, which is a layout rule,
    // not a field box. Requiring a control in the selector list skips it.
    const source = stripped(REMOTE_CSS)
    const fieldRule = [...source.matchAll(/(\[data-remote-control\][^{}]*(?:input|select)[^{}]*)\{([^{}]*)\}/g)]
      .find((m) => m[2]!.includes('min-height'))
    expect(fieldRule?.[1], 'the field rule must exist and carry the select').toContain('select')

    const pads = fieldRule?.[2]?.match(/padding:[^;]+;/g) ?? []
    expect(pads, 'the field box must declare padding once, shared with select').toHaveLength(1)
    expect(pads[0]).toMatch(/padding:\s*6px 12px/)
  })
})