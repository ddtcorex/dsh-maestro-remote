// The plugin manager reads a plugin's display text and artwork WITHOUT running it:
// `dsh-app-boot` (package-meta) resolves `<pkg>/locale/en.json` and the manifest `icon`
// through the Node resolver, so both are packaging contracts, not cosmetics. A missing
// export, a file left out of `files`, or an empty `meta.title` degrades the installed row
// to the bare package name with the panel's default artwork, and it does so silently: the
// failure shows up in Settings > Plugins, not in a build log.
//
// The rules below restate the host's reader, not a preference of this package:
// - the icon is a manifest field naming a path RELATIVE to the package, inside the package,
//   with an SVG/PNG/JPEG/WebP extension, at most 256 KiB;
// - every locale file is resolved as `<pkg>/locale/<language>.json`, so that subpath has to
//   be exported, the file names have to be language ids, and they share one directory;
// - display text lives under `meta.title` and `meta.description`.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

describe('plugin display metadata', () => {
  it('declares a card icon the host can read', () => {
    const icon: unknown = pkg.icon
    expect(typeof icon, 'package.json has no icon field').toBe('string')
    const value = icon as string
    expect(value.trim()).not.toBe('')
    // The host rejects absolute paths and URIs outright.
    expect(isAbsolute(value), `icon must be relative, got ${value}`).toBe(false)
    expect(value).not.toMatch(/^[A-Za-z][A-Za-z\d+.-]*:/)
    // The host refuses an icon outside the manifest directory.
    const inside = relative(root, resolve(root, value))
    expect(inside.startsWith(`..${sep}`) || inside === '..', `icon escapes the package: ${value}`).toBe(false)
    expect(ICON_MEDIA_TYPES.has(value.slice(value.lastIndexOf('.'))), `icon must be SVG, PNG, JPEG or WebP, got ${value}`).toBe(true)
    const stats = statSync(resolve(root, value))
    expect(stats.isFile(), `icon is not a regular file: ${value}`).toBe(true)
    expect(stats.size).toBeLessThanOrEqual(256 * 1024)
  })

  it('ships the icon and the locale directory in the published package', () => {
    // `files` decides what npm publishes; a metadata file outside it works from a local
    // checkout and vanishes for every installed copy.
    expect(pkg.files).toEqual(expect.arrayContaining(['assets', 'locale']))
  })

  it('exports the locale subpath, so the host resolver can reach it', () => {
    // The host resolves `<pkg>/locale/en.json` through the ESM resolver: a missing export is
    // ERR_PACKAGE_PATH_NOT_EXPORTED, which it treats as "this plugin has no metadata".
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
  })

  it('carries both display fields in every locale file', () => {
    const dir = join(root, 'locale')
    const files = readdirSync(dir).filter(name => name.endsWith('.json'))
    // en.json is the file the host resolves first; without it there is no metadata at all,
    // whatever else the directory holds.
    expect(files).toContain('en.json')
    for (const name of files) {
      // The host derives the language from the filename and rejects anything that is not a
      // language id (LANGUAGE_ID in dsh-app-boot).
      expect(name.slice(0, -5), `${name}: not a language id`).toMatch(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/)
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      for (const field of ['title', 'description']) {
        const value = parsed.meta?.[field]
        expect(typeof value, `${name}: meta.${field} must be a string`).toBe('string')
        expect(value.trim(), `${name}: meta.${field} must not be empty`).not.toBe('')
      }
    }
  })
})
