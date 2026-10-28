import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAssemblerClass } from '../../src/host/patch/patches/assembler.js'

/**
 * A packaged dsh runtime keeps `@deepseek-ai/dsh-llm` in its own node_modules,
 * outside a `link:` plugin's require graph. The class the agent loop uses must
 * therefore be resolved from the running entry, not from the plugin or the cwd.
 */
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fakeRuntime(marker: string): { root: string; entry: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-rt-'))
  dirs.push(root)
  const llm = join(root, 'node_modules/@deepseek-ai/dsh-llm')
  mkdirSync(llm, { recursive: true })
  writeFileSync(join(llm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', main: 'index.cjs' }))
  writeFileSync(join(llm, 'index.cjs'), `class BlockAssembler {}\nBlockAssembler.marker = ${JSON.stringify(marker)}\nmodule.exports = { BlockAssembler }\n`)
  mkdirSync(join(root, 'lib'))
  mkdirSync(join(root, 'bin'))
  const entry = join(root, 'lib/bin.js')
  writeFileSync(entry, '')
  const bin = join(root, 'bin/dsh')
  symlinkSync('../lib/bin.js', bin)
  return { root, entry, bin }
}

describe('resolveAssemblerClass', () => {
  it('resolves the class from the running packaged entry', () => {
    const rt = fakeRuntime('packaged')
    const cls = resolveAssemblerClass({ entry: rt.entry, cwd: '/nonexistent' }) as unknown as { marker?: string }
    expect(cls?.marker).toBe('packaged')
  })

  it('follows the installed bin symlink to the runtime package', () => {
    const rt = fakeRuntime('via-bin')
    const cls = resolveAssemblerClass({ entry: rt.bin, cwd: '/nonexistent' }) as unknown as { marker?: string }
    expect(cls?.marker).toBe('via-bin')
  })

  it('leaves a source launch (bin.ts) to the existing resolution paths', () => {
    const rt = fakeRuntime('should-not-load')
    const ts = join(rt.root, 'lib/bin.ts')
    writeFileSync(ts, '')
    const cls = resolveAssemblerClass({ entry: ts, cwd: '/nonexistent' }) as unknown as { marker?: string } | undefined
    expect(cls?.marker).not.toBe('should-not-load')
  })
})

describe('patchAssembler', () => {
  it('reports which resolution path installed the restore', async () => {
    const { patchAssembler } = await import('../../src/host/patch/patches/assembler.js')
    const rt = fakeRuntime('logged')
    const lines: string[] = []
    const disposers: Array<() => void> = []
    patchAssembler({ effect: (fn: () => unknown) => { const d = fn(); if (typeof d === 'function') disposers.push(d as () => void) } }, {
      where: { entry: rt.entry, cwd: '/nonexistent' },
      log: (line: string) => lines.push(line),
    })
    disposers.forEach(d => d())
    expect(lines).toEqual(['[maestro-patch] BlockAssembler restore installed via packaged runtime'])
  })

  it('warns when no BlockAssembler resolves', async () => {
    const { patchAssembler } = await import('../../src/host/patch/patches/assembler.js')
    const lines: string[] = []
    patchAssembler({ effect: (fn: () => unknown) => fn() }, {
      where: { entry: '/nonexistent/bin.ts', cwd: '/nonexistent' },
      resolve: () => undefined,
      log: (line: string) => lines.push(line),
    })
    expect(lines).toEqual(['[maestro-patch] BlockAssembler not found, tool-call id/name restore inactive'])
  })
})
