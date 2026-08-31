/**
 * Patch BlockAssembler so DeepSeek's OpenAI-style streaming (id/name only on the
 * first per-index delta; later deltas repeat the index with `id: ''` and
 * `name: null`) cannot clobber a tool call's real identity. The restore wrapper
 * captures the FIRST non-empty id/name per block index and re-applies them onto
 * the assembled tool-call, so a call that reached the wire with a real name
 * dispatches instead of failing `unknown tool ""` (V4-flash regression, 2026-09-01).
 *
 * Also keeps the historical degenerate-drop for genuinely empty tool calls
 * (dsh-tools keepBlock contract). Feature-detects upstream: if the restored
 * id/name logic is already present, no-ops.
 *
 * The runtime class is reached through several resolution paths: the package
 * name via the caller's require graph, the built `lib/assembler.js` under the
 * harness workspace (published/installed installs), and the source
 * `src/assembler.ts` (source launch via tsx), where `require('<abs>.ts')` yields
 * the same module instance the agent loop uses.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type AssemblerLike = { prototype: Record<string, unknown> }

/**
 * Wrap `push` and `assemble` to restore a tool-call's first non-empty id/name
 * when the closed `block-end` block (or the delta clobber) lost them.
 * @param BlockAssemblerLike - the runtime BlockAssembler class (prototype patched in place).
 * @returns the exact disposer that restores the original methods.
 */
export function applyAssemblerRestore(BlockAssemblerLike: AssemblerLike): () => void {
  const proto = BlockAssemblerLike.prototype
  const existingPush = proto['push'] as unknown
  const existingAssemble = proto['assemble'] as unknown
  if (typeof existingPush !== 'function' || typeof existingAssemble !== 'function') return () => {}
  // Idempotent: an already-patched assemble carries the literal marker in its body.
  if (String(existingAssemble).includes('__dmpFirstToolCall')) return () => {}

  const prevPush = existingPush as (this: unknown, chunk: unknown) => unknown
  const prevAssemble = existingAssemble as (this: unknown, partial: unknown, index: number) => unknown

  proto['push'] = function (this: Record<string, unknown>, chunk: {
    type?: string
    index?: number
    id?: string | null
    name?: string | null
  } & Record<string, unknown>): unknown {
    if (chunk?.type === 'tool-call-delta' && chunk.index !== undefined) {
      let map = this['__dmpFirstToolCall'] as Map<number, { id: string; name: string }> | undefined
      if (map === undefined) {
        map = new Map()
        this['__dmpFirstToolCall'] = map
      }
      let rec = map.get(chunk.index)
      if (rec === undefined) {
        rec = { id: '', name: '' }
        map.set(chunk.index, rec)
      }
      if (rec.id === '' && typeof chunk.id === 'string' && chunk.id.length > 0) rec.id = chunk.id
      if (rec.name === '' && typeof chunk.name === 'string' && chunk.name.length > 0) rec.name = chunk.name
    }
    return prevPush.call(this, chunk)
  }

  proto['assemble'] = function (this: Record<string, unknown>, partial: unknown, index: number): unknown {
    const block = prevAssemble.call(this, partial, index) as {
      type?: string
      id?: string | null
      name?: string | null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any
    } | null
    if (block === null || block === undefined || block.type !== 'tool-call') return block
    const map = this['__dmpFirstToolCall'] as Map<number, { id: string; name: string }> | undefined
    const rec = map?.get(index)
    if (rec === undefined) return block
    const restoredId = (block.id === undefined || block.id === '') && rec.id !== '' ? rec.id : block.id
    const restoredName = (block.name === undefined || block.name === '') && rec.name !== '' ? rec.name : block.name
    if (restoredId === block.id && restoredName === block.name) return block
    return { ...block, id: restoredId, name: restoredName }
  }

  return () => {
    proto['push'] = prevPush
    proto['assemble'] = prevAssemble
  }
}

/**
 * Locate the runtime `BlockAssembler` class across package-name, built-lib, and
 * source-launch resolution paths. The source path matters because the Maestro
 * host runs DSH from its `src/` via tsx, and `require()` of the same `.ts` file
 * returns the exact class instance the agent loop imports.
 * @returns the resolved class, or undefined when no copy resolves.
 */
export function resolveAssemblerClass(): AssemblerLike | undefined {
  const req = createRequire(import.meta.url)
  const base = join(dirname(fileURLToPath(import.meta.url)))

  // Harness workspace candidates. The running `dsh web` boots from the harness
  // source via tsx (cwd == <harness>); the relative form covers the Maestro
  // plugin checkout (lib/ dir) regardless of working directory. Prefer source
  // `.ts` over built `lib/.js` so the patched class is the one the loop uses
  // under source launch.
  const harness = [
    '',
    'deepseek-harness',
  ]
  const candidates = [
    // Installed package through the caller's require graph (published installs).
    '@deepseek-ai/dsh-llm',
  ]
  for (const prefix of harness) {
    for (const file of ['packages/llm/llm/src/assembler.ts', 'packages/llm/llm/lib/assembler.js']) {
      candidates.push(join(process.cwd(), prefix, file))
    }
  }
  for (const file of ['packages/llm/llm/src/assembler.ts', 'packages/llm/llm/lib/assembler.js']) {
    candidates.push(join(base, '../../../deepseek-harness', file))
  }
  for (const candidate of candidates) {
    try {
      const mod = req(candidate) as { BlockAssembler?: AssemblerLike }
      if (typeof mod?.BlockAssembler === 'function') {
        return mod.BlockAssembler
      }
    } catch {
      // try the next resolution path
    }
  }
  return undefined
}

/**
 * The historical degenerate-tool-call drop: tool-calls that assembled with an
 * empty name or id are not executable (dispatch would fail `UNKNOWN_TOOL`), so
 * they are dropped unless the finish is not max-tokens.
 */
function isDegenerateToolCall(block: { type: string; name?: string; id?: unknown }): boolean {
  if (block.type !== 'tool-call') return false
  const name = (block.name ?? '').trim()
  const id = String(block.id ?? '')
  return name === '' || id.length === 0
}

/**
 * Install the zero-fork BlockAssembler shims (id/name restore + degenerate drop)
 * for the harness runtime. Reversible: disposing restores original methods.
 * @param ctx - the Cordis context (uses only `effect`).
 * @returns the combined disposer when a class resolved, else undefined.
 */
export function patchAssembler(ctx: { effect: (fn: () => unknown, label?: string) => unknown }): unknown {
  return ctx.effect(() => {
    const BlockAssembler = resolveAssemblerClass()
    if (!BlockAssembler) return
    const proto = BlockAssembler.prototype
    const disposers: Array<() => void> = []

    // 1) Restore first non-empty tool-call id/name (V4-flash streaming regression).
    disposers.push(applyAssemblerRestore(BlockAssembler))

    // 2) Historical degenerate-drop, feature-detected against upstream keepBlock.
    const existingKeep = proto['keepBlock'] as unknown
    if (typeof existingKeep === 'function') {
      const src = String(existingKeep)
      if (src.includes('name.trim()') && src.includes('String(block.id)')) {
        // Upstream already has the degenerate-drop fix — nothing to shim.
        return () => { for (const d of disposers) d() }
      }
      const prevKeep = existingKeep as (block: { type: string; name?: string; id?: unknown }) => boolean
      const keepBlock = function (this: { finish: { kind: string } }, block: { type: string; name?: string; id?: unknown }): boolean {
        if (block.type !== 'tool-call') return true
        if (this.finish?.kind === 'max-tokens') return false
        return !isDegenerateToolCall(block)
      }
      proto['keepBlock'] = keepBlock as never
      disposers.push(() => { proto['keepBlock'] = prevKeep as never })

      // Keep `assembled` in agreement with the overridden keepBlock if it still
      // uses the old inline logic.
      const assembledSrc = String(proto['assembled'] ?? '')
      if (!assembledSrc.includes('keepBlock')) {
        const origAssembled = proto['assembled'] as ((() => { blocks: unknown[]; replay: unknown }) | undefined)
        if (origAssembled) {
          const prevAssembled = origAssembled
          proto['assembled'] = function (this: {
            finish: { kind: string }
            order: number[]
            mustGet: (i: number) => unknown
            assemble: (p: unknown, i: number) => { type: string; name?: string; id?: unknown }
            _replayState: { blocks?: unknown[]; response: unknown } | undefined
          }) {
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
          } as never
          disposers.push(() => { proto['assembled'] = prevAssembled as never })
        }
      }
    } else {
      // No keepBlock at all — wrap `assembled` to apply the degenerate-drop.
      const origAssembled = proto['assembled'] as ((() => { blocks: unknown[]; replay: unknown }) | undefined)
      if (typeof origAssembled !== 'function') return () => { for (const d of disposers) d() }
      const wrapped = function (this: {
        finish: { kind: string }
        order: number[]
        mustGet: (i: number) => unknown
        assemble: (p: unknown, i: number) => { type: string; name?: string; id?: unknown }
        _replayState: { blocks?: unknown[]; response: unknown } | undefined
      }) {
        const all = this.order.map((index: number) => this.assemble(this.mustGet(index), index))
        const kept = all.map((block) => {
          if (block.type !== 'tool-call') return true
          if (this.finish?.kind === 'max-tokens') return false
          return !isDegenerateToolCall(block as never)
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
      proto['assembled'] = wrapped as never
      disposers.push(() => { proto['assembled'] = origAssembled as never })
    }

    return () => { for (const d of disposers) d() }
  }, 'maestro-patch:assembler')
}