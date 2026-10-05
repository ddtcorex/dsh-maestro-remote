/**
 * The settings store is embedded in this package as one generated file. The
 * gate is what stops a hand edit or a copy generated from an older core store
 * from shipping to npm unnoticed: nobody re-reads `src/host/vendor/store.ts`
 * when they change a settings field.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'src/host/vendor/store.ts')
const script = join(root, 'scripts/vendor-store.mjs')

async function loadScript() {
  return (await import(/* @vite-ignore */ script) as {
    buildBody: (sourceDir: string) => string
    renderVendored: (body: string) => string
    verifyVendored: (file: string, sourceDir?: string) => { ok: boolean; reason?: string }
  })
}

/**
 * A core checkout, when one is reachable: the env var a CI sibling step sets,
 * or a sibling package directory in a full workspace checkout. Absent in this
 * repository's own CI clone until core merges, and that is accepted on
 * purpose — the header hash still catches every hand edit, which is the
 * failure mode that actually reaches npm.
 */
function coreSourceDir(): string | undefined {
  const candidates = [
    process.env.MAESTRO_CORE_DIR,
    resolve(root, '..', 'dsh-maestro-core', 'src/host/store'),
    resolve(root, '..', 'dsh-maestro-supervisor', 'src/host/store'),
  ].filter(Boolean) as string[]
  return candidates.find((dir) => existsSync(join(dir, 'index.ts')))
}

describe('vendored settings store', () => {
  it('is sealed by a header hash that matches its body', async () => {
    const { verifyVendored } = await loadScript()
    expect(verifyVendored(file)).toEqual({ ok: true })
  })

  it('carries both the store and the legacy adapter in one module', () => {
    const [header, ...rest] = readFileSync(file, 'utf8').split('\n')
    const body = rest.join('\n')
    expect(header).toBe(`// vendored from dsh-maestro-core store, sha256:${createHash('sha256').update(body).digest('hex')}`)
    expect(body).toContain('export async function load')
    expect(body).toContain('export async function readFlat')
    expect(body).not.toContain("from './index.js'")
  })

  it('registers no domain validator at import', () => {
    // The store declares no schema of its own; each owner calls defineDomain,
    // so a plugin that is not installed cannot impose one.
    const body = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')
    expect(body).not.toMatch(/defineDomain\('(review|notifier|tunnel|gitlab|guard)'/)
  })

  it('matches what a reachable core source produces', async () => {
    const sourceDir = coreSourceDir()
    if (!sourceDir) {
      console.info('[vendor-store] no core checkout reachable; source comparison skipped')
      return
    }
    const { buildBody, renderVendored } = await loadScript()
    expect(readFileSync(file, 'utf8')).toBe(renderVendored(buildBody(sourceDir)))
  })

  it('rejects a hand edit', async () => {
    const { verifyVendored } = await loadScript()
    const dir = mkdtempSync(join(tmpdir(), 'vendor-drift-'))
    const copy = join(dir, 'store.ts')
    writeFileSync(copy, readFileSync(file, 'utf8') + '\n// edited')
    expect(verifyVendored(copy).ok).toBe(false)
  })

  it('rejects a copy generated from an older core source', async () => {
    const sourceDir = coreSourceDir()
    if (!sourceDir) return
    const { verifyVendored } = await loadScript()
    const stale = mkdtempSync(join(tmpdir(), 'vendor-stale-'))
    writeFileSync(join(stale, 'index.ts'), '// an older core store\nexport const marker = 1\n')
    writeFileSync(join(stale, 'legacy.ts'), "import { load } from './index.js'\nexport const legacy = 1\n")
    const verdict = verifyVendored(file, stale)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toMatch(/differs from the core source/)
  })
})