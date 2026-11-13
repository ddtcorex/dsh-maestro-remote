import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM helper without types
import { skipDecision } from '../client/build-decision.mjs'

describe('login bundle skip decision', () => {
  it('warns and succeeds when the bundle is optional', () => {
    const d = skipDecision({ packageRoot: '/tmp/pkg', required: false })
    expect(d.exitCode).toBe(0)
    expect(d.stream).toBe('stderr')
    expect(d.message).toContain('NOT rebuilt')
    expect(d.message).toContain('native sign-in form covers it')
  })

  it('fails a required build instead of shipping without the bundle', () => {
    const d = skipDecision({ packageRoot: '/tmp/pkg', required: true })
    expect(d.exitCode).toBe(1)
    expect(d.message).toContain('cannot ship without the bundle')
  })
})
