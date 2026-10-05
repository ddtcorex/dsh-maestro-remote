// The client module scan walks the host Loader's entries and resolves each
// `name` to a package root. A row addressed only by subpath
// (`@ddtcorex/x/lib/y.js`) has no package root, so the scan treats the package
// as "permanently not a client row": its `dsh.client` declaration is never read
// and lib/client.js is never served, which drops the settings section with no
// boot error naming the cause. At least one row per package must carry the bare
// package name.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')

describe('cordis.patch.yml row addressing', () => {
  it('declares at least one row by the bare package name', () => {
    expect(patch).toMatch(new RegExp(`name:\\s*'${pkg.name.replace('/', '\\/')}'`))
  })

  it('keeps the subpath rows it needs', () => {
    // The tunnel provider and the absorbed patch shim are separate rows on
    // purpose: the patches must work with the tunnel off.
    expect(patch).toContain("'@ddtcorex/dsh-maestro-remote/lib/tunnel.js'")
    expect(patch).toContain("'@ddtcorex/dsh-maestro-remote/lib/patch/index.js'")
  })

  it('resolves every declared name to a file that exists', () => {
    for (const m of patch.matchAll(/name:\s*'(@ddtcorex\/[^']+)'/g)) {
      const spec = m[1]
      const rel = spec === pkg.name ? '.' : spec.replace(`${pkg.name}/`, '')
      const file = spec === pkg.name
        ? resolve(root, 'lib/index.js')
        : resolve(root, rel)
      expect(existsSync(file), `${spec} -> ${file}`).toBe(true)
    }
  })
})

import { existsSync } from 'node:fs'