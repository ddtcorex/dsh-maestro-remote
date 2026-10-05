/**
 * The settings store is embedded in this package as one generated file. The
 * gate is what stops a hand edit or a copy generated from an older core store
 * from shipping to npm unnoticed: nobody re-reads `src/host/vendor/store.ts`
 * when they change a settings field.
 *
 * Two halves, because they catch different failures:
 *
 * - **Header hash vs. own body** catches a HAND EDIT. It cannot catch a copy
 *   generated from an older core store — that copy hashes correctly against its
 *   own header.
 * - **Pinned upstream hash** catches the OLD COPY, and needs no clone, no
 *   network and no sibling checkout, so it runs in this repository's own CI,
 *   which never has a core checkout. Measured 2026-10-05: all five consumers
 *   were green here while every one of them carried the pre-hardening store,
 *   because the comparison half hit `if (!sourceDir) return` and asserted
 *   nothing.
 *
 * A reachable core checkout adds the full source comparison on top; it is
 * strictly stronger, never weaker.
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

/**
 * sha256 of dsh-maestro-core's store body — everything after the header line,
 * i.e. `buildBody(<core>/src/host/store)`.
 *
 * Bump ONLY by running core's `node scripts/vendor-store.mjs <this package>`
 * and committing the regenerated file in the same change. A literal bump with
 * no regenerated file is exactly the regression this gate exists to catch, and
 * it fails the `is sealed by a header hash` case rather than passing quietly.
 */
const UPSTREAM_STORE_SHA256 = 'ca062c527bb30c030c086751be275ee379071f33691568ff7d0eae4372012829'

async function loadScript() {
  return (await import(/* @vite-ignore */ script) as {
    buildBody: (sourceDir: string) => string
    hashBody: (body: string) => string
    renderVendored: (body: string) => string
    verifyVendored: (file: string, sourceDir?: string) => { ok: boolean; reason?: string }
  })
}

function bodyOf(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? '' : text.slice(newline + 1)
}

/**
 * A core checkout, when one is reachable: the env var a CI sibling step sets,
 * or a sibling package directory in a full workspace checkout. Absent in this
 * repository's own CI clone, which is why the pinned hash above carries the
 * old-copy check on its own.
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

  it('is byte-identical to the pinned upstream core store', async () => {
    // The half that runs WITHOUT a core checkout, which is why it is the one
    // that has to be unconditional.
    const { hashBody } = await loadScript()
    expect(hashBody(bodyOf(readFileSync(file, 'utf8')))).toBe(UPSTREAM_STORE_SHA256)
  })

  it('rejects a copy generated from an older core source, without a checkout', async () => {
    // Proves the pinned check can fail. A stale copy is self-consistent, so
    // verifyVendored(file) alone returns ok — that is the gap this closes.
    const { buildBody, hashBody, renderVendored } = await loadScript()
    const stale = mkdtempSync(join(tmpdir(), 'vendor-pinned-'))
    writeFileSync(join(stale, 'index.ts'), '// an older core store\nexport const marker = 1\n')
    writeFileSync(join(stale, 'legacy.ts'), "import { load } from './index.js'\nexport const legacy = 1\n")
    const staleCopy = join(stale, 'store.ts')
    writeFileSync(staleCopy, renderVendored(buildBody(stale)))

    expect(hashBody(bodyOf(readFileSync(staleCopy, 'utf8')))).not.toBe(UPSTREAM_STORE_SHA256)
    expect(hashBody(bodyOf(readFileSync(file, 'utf8')))).toBe(UPSTREAM_STORE_SHA256)
  })

  it('matches what a reachable core source produces', async () => {
    const sourceDir = coreSourceDir()
    if (!sourceDir) {
      console.info('[vendor-store] no core checkout reachable; the pinned upstream hash already ran')
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