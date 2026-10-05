#!/usr/bin/env node
/**
 * Vendor the settings store into a consumer package.
 *
 * Every plugin embeds its own copy of the store so the plugins stay independent
 * packages with no shared dependency. The copy is generated from the core
 * source rather than copied by hand, and the first line carries the sha256 of
 * the body, so a consumer's drift test can tell "generated from the current
 * core store" from "hand edited" or "generated from an older core store".
 *
 *   node scripts/vendor-store.mjs <consumer-package-dir>
 *
 * Writes `<consumer-package-dir>/src/host/vendor/store.ts`. No dependencies:
 * the consumers run this from their own `node scripts/`, and a vendoring step
 * that needs an install is a vendoring step that does not get run.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The core root is the parent of scripts/. */
const CORE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_SOURCE_DIR = join(CORE_ROOT, 'src', 'host', 'store')
const RELATIVE_OUT = join('src', 'host', 'vendor', 'store.ts')

/**
 * legacy.ts imports load/set from './index.js'. Concatenated into one module
 * those symbols are already in scope, so the import line is dropped.
 */
const CROSS_FILE_IMPORT = /^import\s+\{[^}]*\}\s+from\s+'\.\/index\.js'\s*\n/m

/** Concatenate the two store sources into the single-module body. */
export function buildBody(sourceDir) {
  const index = readFileSync(join(sourceDir, 'index.ts'), 'utf8')
  const legacy = readFileSync(join(sourceDir, 'legacy.ts'), 'utf8')
  const stripped = legacy.replace(CROSS_FILE_IMPORT, '')
  if (stripped === legacy) {
    throw new Error(`vendor-store: no './index.js' import found in ${join(sourceDir, 'legacy.ts')}`)
  }
  return `${index}\n${stripped}`
}

export function hashBody(body) {
  return createHash('sha256').update(body).digest('hex')
}

/** Render the vendored file: the hash line, then the body it describes. */
export function renderVendored(body) {
  return `// vendored from dsh-maestro-core store, sha256:${hashBody(body)}\n${body}`
}

/** Write the vendored copy into a consumer package; returns the file written. */
export function vendorStore(targetDir, sourceDir = DEFAULT_SOURCE_DIR) {
  const file = join(targetDir, RELATIVE_OUT)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, renderVendored(buildBody(sourceDir)))
  return file
}

/**
 * Check one vendored copy. With `sourceDir` the body is also compared against
 * what the core store produces today, which is the half a self-consistency
 * check cannot see: a copy generated from an older core store still hashes
 * correctly against its own header.
 */
export function verifyVendored(file, sourceDir) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, reason: `cannot read ${file}: ${err.message}` }
  }
  const newline = text.indexOf('\n')
  const header = newline === -1 ? text : text.slice(0, newline)
  const body = newline === -1 ? '' : text.slice(newline + 1)
  const match = /^vendored from dsh-maestro-core store, sha256:([0-9a-f]{64})$/.exec(header.replace(/^\/\/ /, ''))
  if (!match) return { ok: false, reason: 'missing or malformed vendored header' }
  const actual = hashBody(body)
  if (actual !== match[1]) {
    return { ok: false, reason: 'body hash does not match the header', expected: match[1], actual }
  }
  if (sourceDir !== undefined) {
    if (buildBody(sourceDir) !== body) {
      return { ok: false, reason: 'vendored body differs from the core source' }
    }
  }
  return { ok: true }
}

function main(argv) {
  const target = argv[0]
  if (!target) {
    console.error('usage: node scripts/vendor-store.mjs <consumer-package-dir>')
    return 2
  }
  const file = vendorStore(target)
  console.log(`vendored ${file}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}