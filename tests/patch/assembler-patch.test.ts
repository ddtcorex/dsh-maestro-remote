import { describe, expect, it } from 'vitest'
import { applyAssemblerRestore } from '../src/host/patches/assembler.js'

/**
 * Minimal stand-in that reproduces the real `BlockAssembler` (dsh-llm) surface
 * for the tool-call deltas/block-end path this patch protects: `push` hands a
 * `tool-call-delta`'s id/name to the partial, and `assemble` returns the closed
 * `block-end` block verbatim when one arrived. The V4-flash wire shape repeats a
 * block index with `id: ''` / `name: null` after the first delta, which is what
 * clobbers `toolCallId` on the real class too.
 */
class FakeBlockAssembler {
  partials = new Map<number, {
    block?: { type: string; id?: string; name?: string; arguments?: string } | undefined
    toolCallId?: string | undefined
    toolCallName?: string | undefined
    toolCallArguments: string
  }>()

  push(chunk: {
    type: string
    index?: number
    id?: string
    name?: string | null
    argumentsDelta?: string
    block?: { type: string; id?: string; name?: string; arguments?: string }
  }): void {
    if (chunk.index === undefined) return
    const partial = this.partials.get(chunk.index) ?? { toolCallArguments: '' }
    this.partials.set(chunk.index, partial)
    if (chunk.type === 'tool-call-delta') {
      partial.toolCallId = chunk.id
      if (chunk.name) partial.toolCallName = chunk.name
      partial.toolCallArguments += chunk.argumentsDelta ?? ''
    }
    if (chunk.type === 'block-end' && chunk.block) partial.block = chunk.block
  }

  assemble(partial: { block?: { type: string; id?: string; name?: string; arguments?: string } | undefined; toolCallId?: string | undefined; toolCallName?: string | undefined; toolCallArguments: string }, index: number): { type: string; id?: string; name?: string; arguments?: string } {
    if (partial.block) return partial.block
    return {
      type: 'tool-call',
      id: partial.toolCallId ?? `call-${index}`,
      name: partial.toolCallName ?? '',
      arguments: partial.toolCallArguments,
    }
  }

  blocks(): { type: string; id?: string; name?: string; arguments?: string }[] {
    return [...this.partials.entries()].map(([index, partial]) => this.assemble(partial, index))
  }
}

/** The exact V4-flash stream shape captured live (2026-09-01 session-97df783b). */
function v4FlashSeed(instance: FakeBlockAssembler): void {
  instance.push({ type: 'tool-call-delta', index: 0, id: 'call_aedb6d00726745b5ab9667d1', name: 'bash', argumentsDelta: '' })
  instance.push({ type: 'tool-call-delta', index: 0, id: '', name: null, argumentsDelta: '{"command":' })
  instance.push({ type: 'tool-call-delta', index: 0, id: '', name: null, argumentsDelta: '"pwd && ls packages/"}' })
  instance.push({
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: '', name: '', arguments: '{"command": "pwd && ls packages/"}' },
  })
}

describe('assembler restore patch (tool-call id/name)', () => {
  it('regression: unpatched assembler loses id/name on V4-flash repeats (unknown tool "")', () => {
    const instance = new FakeBlockAssembler()
    v4FlashSeed(instance)
    const block = instance.blocks()[0]!
    expect(block.id).toBe('')
    expect(block.name).toBe('')
  })

  it('restores the first non-empty id/name onto the closed tool-call block', () => {
    const patched = applyAssemblerRestore(FakeBlockAssembler as never)
    try {
      const instance = new FakeBlockAssembler()
      v4FlashSeed(instance)
      const block = instance.blocks()[0]!
      expect(block).toMatchObject({
        type: 'tool-call',
        id: 'call_aedb6d00726745b5ab9667d1',
        name: 'bash',
        arguments: '{"command": "pwd && ls packages/"}',
      })
    } finally {
      patched()
    }
  })

  it('restores independently for parallel tool-call indices', () => {
    const patched = applyAssemblerRestore(FakeBlockAssembler as never)
    try {
      const instance = new FakeBlockAssembler()
      instance.push({ type: 'tool-call-delta', index: 0, id: 'call_a', name: 'grep', argumentsDelta: '{"pattern":' })
      instance.push({ type: 'tool-call-delta', index: 0, id: '', name: null, argumentsDelta: ' "x"}' })
      instance.push({
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: '', name: '', arguments: '{"pattern": "x"}' },
      })
      instance.push({ type: 'tool-call-delta', index: 1, id: 'call_b', name: 'read', argumentsDelta: '{}' })
      instance.push({ type: 'tool-call-delta', index: 1, id: '', name: null, argumentsDelta: '' })
      instance.push({
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: '', name: '', arguments: '{}' },
      })
      const [a, b] = instance.blocks()
      expect(a).toMatchObject({ id: 'call_a', name: 'grep' })
      expect(b).toMatchObject({ id: 'call_b', name: 'read' })
    } finally {
      patched()
    }
  })

  it('leaves an already-complete id/name untouched', () => {
    const patched = applyAssemblerRestore(FakeBlockAssembler as never)
    try {
      const instance = new FakeBlockAssembler()
      instance.push({ type: 'tool-call-delta', index: 0, id: 'call_ok', name: 'bash', argumentsDelta: '{}' })
      instance.push({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_ok', name: 'bash', arguments: '{}' } })
      expect(instance.blocks()[0]).toMatchObject({ id: 'call_ok', name: 'bash', arguments: '{}' })
    } finally {
      patched()
    }
  })

  it('is idempotent: applying twice keeps single wrapper layers', () => {
    const first = applyAssemblerRestore(FakeBlockAssembler as never)
    const second = applyAssemblerRestore(FakeBlockAssembler as never)
    try {
      const instance = new FakeBlockAssembler()
      v4FlashSeed(instance)
      expect(instance.blocks()[0]).toMatchObject({ id: 'call_aedb6d00726745b5ab9667d1', name: 'bash' })
    } finally {
      second()
      first()
    }
  })

  it('disposer restores the unpatched behavior', () => {
    const patched = applyAssemblerRestore(FakeBlockAssembler as never)
    patched()
    const instance = new FakeBlockAssembler()
    v4FlashSeed(instance)
    expect(instance.blocks()[0]).toMatchObject({ id: '', name: '' })
  })
})