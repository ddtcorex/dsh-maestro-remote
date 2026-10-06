import { describe, expect, it } from 'vitest'
import { REMOTE_CSS } from '../src/client/remote/styles.js'

// On a phone the settings rows stack, and every field must then use the full
// width, with or without a Save button beside it (button stays on the same row,
// the input takes the rest). A checkbox row is the exception to stacking: its
// label stays left and the box is held right as a 44px tap target on ONE line,
// instead of a lone 16px box sitting on a line of its own under the label.
const css = REMOTE_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const phone = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? ''
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(phone)?.[1] ?? ''
}

describe('remote settings on a phone', () => {
  it('has a phone block to read', () => {
    expect(phone).not.toBe('')
  })

  it('gives the control the full row width', () => {
    expect(rule('[data-remote-control]')).toMatch(/width:\s*100%/)
  })

  it('lets text fields and selects fill the control', () => {
    const body = rule('[data-remote-control] input[type="text"], [data-remote-control] input[type="password"], [data-remote-control] select')
    expect(body).toMatch(/flex:\s*1 1 auto/)
    expect(body).toMatch(/min-width:\s*0/)
    expect(body).toMatch(/width:\s*100%/)
  })


  it('keeps a checkbox row on one line, label left and box right', () => {
    const row = rule('[data-remote-row]:has(> [data-remote-control] > input[type="checkbox"]:only-child)')
    expect(row).toMatch(/flex-direction:\s*row/)
    expect(row).toMatch(/align-items:\s*center/)
    const control = rule('[data-remote-row]:has(> [data-remote-control] > input[type="checkbox"]:only-child) [data-remote-control]')
    expect(control).toMatch(/flex:\s*none/)
    expect(control).toMatch(/width:\s*auto/)
  })

  it('gives the checkbox a 44px tap target', () => {
    const control = rule('[data-remote-row]:has(> [data-remote-control] > input[type="checkbox"]:only-child) [data-remote-control]')
    expect(control).toMatch(/min-width:\s*44px/)
    expect(control).toMatch(/min-height:\s*44px/)
  })
})
