import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)

function resolveDshRepo() {
  if (process.env.DSH_REPO) return resolve(process.env.DSH_REPO)
  let workspaceRoot = packageRoot
  for (;;) {
    const workspaceCheckout = join(workspaceRoot, 'deepseek-harness')
    if (existsSync(join(workspaceCheckout, 'package.json'))) return workspaceCheckout
    const parent = dirname(workspaceRoot)
    if (parent === workspaceRoot) break
    workspaceRoot = parent
  }
  throw new Error(`login bundle: cannot find the DeepSeek Harness checkout — set DSH_REPO (searched ancestors of ${packageRoot})`)
}

const dshRepo = resolveDshRepo()
const clientSource = (...parts) => join(dshRepo, 'packages/client', ...parts)

await build({
  entryPoints: [resolve(packageRoot, 'client/login.jsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100'],
  jsx: 'automatic',
  alias: {
    clsx: require.resolve('clsx'),
    '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx': clientSource('ui-primitives/src/Button.tsx'),
    '@deepseek-ai/dsh-client-ui-primitives/src/Input.tsx': clientSource('ui-primitives/src/Input.tsx'),
    '@deepseek-ai/dsh-client-ui-primitives/src/BrandWordmark.tsx': clientSource('ui-primitives/src/BrandWordmark.tsx'),
    '@deepseek-ai/dsh-client-ui-theme/src/styles/base.css': clientSource('ui-theme/src/styles/base.css'),
    '@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css': clientSource('ui-theme/src/styles/design-platform.css'),
  },
  outdir: resolve(packageRoot, 'client'),
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'none',
})
