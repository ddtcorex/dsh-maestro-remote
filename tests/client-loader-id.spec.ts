// The browser loader keys a bundle by the id inside `__ModuleLoader__.load`.
// A wrong id is silent in every build and loud only at boot: the host reports
// "loaded without registering <this package> via __ModuleLoader__.load" and
// drops the entry, so the Settings section never appears. Deriving the id from
// package.json is what makes a copied build script safe to copy.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const bundle = readFileSync(resolve(root, 'lib/client.js'), 'utf8')

describe('client bundle loader id', () => {
  it("registers this package's own name", () => {
    expect(bundle).toContain(`id: '${pkg.name}'`)
  })

  it('registers exactly one id', () => {
    expect(bundle.match(/__ModuleLoader__\.load\(\{/g)).toHaveLength(1)
    const ids = [...bundle.matchAll(/__ModuleLoader__\.load\(\{\s*id: '([^']+)'/g)].map((m) => m[1])
    expect(ids).toEqual([pkg.name])
  })

  it('is wrapped for the loader at all, not raw tsc output', () => {
    // Plain `export function apply` never reaches the browser; esbuild wraps it.
    expect(bundle.startsWith('window.__ModuleLoader__.load({')).toBe(true)
  })
})