// Bundle the Remote section UI for the DSH browser loader with esbuild.
// JSX rides the bundle; react and the DSH platform modules stay external and
// resolve from the host's module table at runtime (same contract as the
// dsh-maestro-config / dsh-maestro-sync build-client scripts).
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = resolve(root, 'lib/client.js')
// The loader id is the manifest name, read rather than written out: this script
// was copied from a sibling package, and the copy shipped that sibling's id, so
// the bundle registered under a name the host never asked for.
const id = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).name

const result = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  jsx: 'automatic',
  write: false,
  minify: process.env.NODE_ENV === 'production',
  legalComments: 'none',
})

const bundled = result.outputFiles?.[0]?.text
if (!bundled) throw new Error('esbuild did not produce a client bundle')

const wrapped = `window.__ModuleLoader__.load({
  id: '${id}',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
${bundled}
    return module.exports;
  }
});
`

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, wrapped, 'utf8')
console.log(`client bundle written: ${outputPath} (${bundled.length} bytes)`)
