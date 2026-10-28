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
 * The runtime class is reached through three resolution paths, first hit
 * wins: the package name from the running dsh entry's require graph (packaged
 * runtime, where a `link:` plugin cannot see the runtime's node_modules), the
 * package name via this plugin's own require graph, and the source
 * `src/assembler.ts` under the harness workspace (source launch via tsx). Each
 * yields the module instance the agent loop uses: `require(esm)` shares the
 * ESM loader cache, and tsx loads the same `.ts` file.
 */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

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

/** A resolved runtime class plus the resolution path that produced it. */
export interface LocatedAssembler {
  cls: AssemblerLike
  via: 'packaged runtime' | 'plugin require graph' | 'source checkout'
}

/**
 * Locate the runtime `BlockAssembler` class across the packaged-runtime,
 * package-name and source-launch resolution paths.
 * @param where - the running dsh entry (default `process.argv[1]`) and the cwd
 *   the source paths are searched under (default `process.cwd()`).
 * @returns the class and its resolution path, or undefined when none resolves.
 */
export function locateAssembler(where: { entry?: string; cwd?: string } = {}): LocatedAssembler | undefined {
  const cwd = where.cwd ?? process.cwd()
  const loaders: Array<[LocatedAssembler['via'], () => unknown]> = []

  // Packaged runtime: `bin/dsh` links to `<pkg>/lib/bin.js`, and dsh-llm sits in
  // that package's node_modules. A source launch runs `bin.ts`, skip it there.
  const entry = where.entry ?? process.argv[1]
  if (entry) {
    let real = entry
    try { real = realpathSync(entry) } catch { /* keep the given path */ }
    if (real.endsWith('.js') || real.endsWith('.mjs')) {
      loaders.push(['packaged runtime', () => createRequire(real)('@deepseek-ai/dsh-llm')])
    }
  }

  const req = createRequire(import.meta.url)
  // Installed package through this plugin's require graph (published installs).
  loaders.push(['plugin require graph', () => req('@deepseek-ai/dsh-llm')])
  // Source launch via tsx (cwd == <harness> or its workspace parent).
  for (const prefix of ['', 'deepseek-harness']) {
    loaders.push(['source checkout', () => req(join(cwd, prefix, 'packages/llm/llm/src/assembler.ts'))])
  }

  for (const [via, load] of loaders) {
    try {
      const mod = load() as { BlockAssembler?: AssemblerLike }
      if (typeof mod?.BlockAssembler === 'function') {
        return { cls: mod.BlockAssembler, via }
      }
    } catch {
      // try the next resolution path
    }
  }
  return undefined
}

/**
 * Locate the runtime `BlockAssembler` class (see {@link locateAssembler}).
 * @returns the resolved class, or undefined when no copy resolves.
 */
export function resolveAssemblerClass(where: { entry?: string; cwd?: string } = {}): AssemblerLike | undefined {
  return locateAssembler(where)?.cls
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
 * @param opts - resolution inputs and the boot log sink, injectable for tests.
 * @returns the combined disposer when a class resolved, else undefined.
 */
export function patchAssembler(
  ctx: { effect: (fn: () => unknown, label?: string) => unknown },
  opts: {
    where?: { entry?: string; cwd?: string }
    resolve?: (where?: { entry?: string; cwd?: string }) => LocatedAssembler | undefined
    log?: (line: string) => void
  } = {},
): unknown {
  // One boot line either way: a restore that silently misses the runtime's
  // module instance is exactly how this shim went inactive unnoticed.
  const log = opts.log ?? ((line: string) => { process.stderr.write(line + '\n') })
  return ctx.effect(() => {
    const located = (opts.resolve ?? locateAssembler)(opts.where)
    if (!located) {
      log('[maestro-patch] BlockAssembler not found, tool-call id/name restore inactive')
      return
    }
    log(`[maestro-patch] BlockAssembler restore installed via ${located.via}`)
    const BlockAssembler = located.cls
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