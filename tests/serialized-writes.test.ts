import { describe, it, expect } from 'vitest'
import { createSerializedWriter } from '../src/host/serialized-writes.ts'

describe('createSerializedWriter', () => {
  it('never overlaps writes and keeps call order', async () => {
    const order: string[] = []
    const gates: Array<() => void> = []
    const write = (value: string): Promise<void> =>
      new Promise<void>((resolve) => {
        order.push(`start:${value}`)
        gates.push(() => { order.push(`end:${value}`); resolve() })
      })
    const serialized = createSerializedWriter(write)
    const first = serialized('a')
    const second = serialized('b')
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['start:a']) // b waits for a
    gates[0]?.()
    await first
    await new Promise((resolve) => setImmediate(resolve))
    expect(order).toEqual(['start:a', 'end:a', 'start:b'])
    gates[1]?.()
    await second
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
  })

  it('runs a later write after a failed one and still reports the failure', async () => {
    const seen: string[] = []
    const serialized = createSerializedWriter<string>(async (value) => {
      seen.push(value)
      if (value === 'boom') throw new Error('write failed')
    })
    const failing = serialized('boom')
    const following = serialized('after')
    await expect(failing).rejects.toThrow('write failed')
    await expect(following).resolves.toBeUndefined()
    expect(seen).toEqual(['boom', 'after'])
  })
})
