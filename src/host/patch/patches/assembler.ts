/**
 * Patch BlockAssembler to drop degenerate tool-calls with empty name or id.
 * Feature-detects upstream: if keepBlock already contains the empty-check, no-ops.
 */

export function patchAssembler(ctx: { effect: (fn: () => unknown, label?: string) => unknown }): unknown {
  return ctx.effect(() => {
    let BlockAssembler: { prototype: Record<string, unknown> } | undefined
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('@deepseek-ai/dsh-llm') as { BlockAssembler?: { prototype: Record<string, unknown> } }
      BlockAssembler = mod.BlockAssembler
    } catch {}
    if (!BlockAssembler) {
      try {
        const path = require('node:path') as typeof import('node:path')
        const fs = require('node:fs') as typeof import('node:fs')
        const candidates = [
          path.join(process.cwd(), 'deepseek-harness/packages/llm/llm/lib/assembler.js'),
          path.join(path.dirname(require('node:url').fileURLToPath(import.meta.url)), '../../../../deepseek-harness/packages/llm/llm/lib/assembler.js'),
        ]
        for (const c of candidates) {
          if (fs.existsSync(c)) {
            try {
              const m = require(c) as { BlockAssembler?: { prototype: Record<string, unknown> } }
              if (m.BlockAssembler) { BlockAssembler = m.BlockAssembler; break }
            } catch {}
          }
        }
      } catch {}
    }
    if (!BlockAssembler) return

    const proto = BlockAssembler.prototype
    const existingKeep = proto['keepBlock'] as unknown

    if (typeof existingKeep === 'function') {
      const src = String(existingKeep)
      if (src.includes('name.trim()') && src.includes('String(block.id)')) {
        // Upstream already has fix — no-op
        return
      }
      // Override incomplete keepBlock
      const prevKeep = existingKeep as (block: { type: string; name?: string; id?: unknown }) => boolean
      const keepBlock = function (this: { finish: { kind: string } }, block: { type: string; name?: string; id?: unknown }): boolean {
        if (block.type !== 'tool-call') return true
        if (this.finish?.kind === 'max-tokens') return false
        const name = (block.name ?? '').trim()
        const id = String((block as { id?: unknown }).id ?? '')
        return name !== '' && id.length !== 0
      }
      proto['keepBlock'] = keepBlock as unknown
      // Also patch assembled to use keepBlock if it still uses old inline logic
      const assembledSrc = String(proto['assembled'] ?? '')
      if (!assembledSrc.includes('keepBlock')) {
        const origAssembled = proto['assembled'] as (() => { blocks: unknown[]; replay: unknown }) | undefined
        if (origAssembled) {
          // Replace assembled with version that uses keepBlock
          proto['assembled'] = function (this: { finish: { kind: string }; order: number[]; mustGet: (i: number) => unknown; assemble: (p: unknown, i: number) => { type: string; name?: string; id?: unknown }; _replayState: { blocks?: unknown[]; response: unknown } | undefined }) {
            const all = this.order.map((index: number) => this.assemble(this.mustGet(index), index))
            const kept = all.map((block) => (keepBlock as unknown as (b: unknown) => boolean).call(this, block as never))
            const blocks = all.filter((_, pos) => kept[pos])
            const envelope = this._replayState
            if (envelope?.blocks === undefined) return { blocks, replay: envelope }
            if (envelope.blocks.length !== all.length) return { blocks, replay: undefined }
            return {
              blocks,
              replay: blocks.length === all.length ? envelope : { response: envelope.response, blocks: envelope.blocks.filter((_, pos) => kept[pos]) },
            }
          } as unknown
        }
      }
      return () => { proto['keepBlock'] = prevKeep as unknown }
    }

    // No keepBlock at all — wrap assembled to add empty-check
    const origAssembled = proto['assembled'] as (() => { blocks: unknown[]; replay: unknown }) | undefined
    if (typeof origAssembled !== 'function') return

    const prevAssembled = origAssembled
    const wrapped = function (this: { finish: { kind: string }; order: number[]; mustGet: (i: number) => unknown; assemble: (p: unknown, i: number) => { type: string; name?: string; id?: unknown }; _replayState: { blocks?: unknown[]; response: unknown } | undefined }) {
      const all = this.order.map((index: number) => this.assemble(this.mustGet(index), index))
      const kept = all.map((block) => {
        if (block.type !== 'tool-call') return true
        if (this.finish?.kind === 'max-tokens') return false
        const name = (block.name ?? '').trim()
        const id = String((block as { id?: unknown }).id ?? '')
        return name !== '' && id.length !== 0
      })
      const blocks = all.filter((_, pos) => kept[pos])
      const envelope = this._replayState
      if (envelope?.blocks === undefined) return { blocks, replay: envelope }
      if (envelope.blocks.length !== all.length) return { blocks, replay: undefined }
      return {
        blocks,
        replay: blocks.length === all.length ? envelope : { response: envelope.response, blocks: envelope.blocks.filter((_, pos) => kept[pos]) },
      }
    }
    proto['assembled'] = wrapped as unknown
    return () => { proto['assembled'] = prevAssembled as unknown }
  }, 'maestro-patch:assembler')
}
