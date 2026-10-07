import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinPath, readLanPin, readPin } from '../src/host/pin-store.ts'

let home: string
let prev: string | undefined
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pin-only-'))
  prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
})
afterEach(async () => {
  if (prev === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prev
  await rm(home, { recursive: true, force: true })
})

describe('PIN-only: pin-store', () => {
  it('pinPath points to .../pin not .../token', () => {
    expect(pinPath()).toBe(join(home, 'dsh-maestro-remote', 'pin'))
  })

  it('readPin ignores a legacy token file and generates a new pin', async () => {
    const dir = join(home, 'dsh-maestro-remote')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'token'), '12345678', 'utf-8')
    const pin = await readPin()
    expect(pin).toMatch(/^\d{8}$/)
    expect(pin).not.toBe('12345678')
    expect((await readFile(join(dir, 'pin'), 'utf-8')).trim()).toBe(pin)
    // the legacy file is left untouched
    expect((await readFile(join(dir, 'token'), 'utf-8')).trim()).toBe('12345678')
  })

  it('readLanPin ignores a legacy token-lan file and generates a new pin', async () => {
    const dir = join(home, 'dsh-maestro-remote')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'token-lan'), '87654321', 'utf-8')
    const pin = await readLanPin()
    expect(pin).toMatch(/^\d{8}$/)
    expect(pin).not.toBe('87654321')
    expect((await readFile(join(dir, 'pin-lan'), 'utf-8')).trim()).toBe(pin)
  })

  it('readPin keeps reading an existing pin even when a stale token file exists', async () => {
    const dir = join(home, 'dsh-maestro-remote')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'pin'), '11112222', 'utf-8')
    await writeFile(join(dir, 'token'), '33334444', 'utf-8')
    expect(await readPin()).toBe('11112222')
  })

  it('readPin does NOT accept ?pin= query — only cookie (checked via isPinAuthorized)', async () => {
    const { isPinAuthorized } = await import('../src/host/remote-proxy.ts')
    // query pin should NOT authorize, only cookie should
    expect(isPinAuthorized({ headers: {}, url: '/?pin=12345678' }, '12345678')).toBe(false)
    expect(isPinAuthorized({ headers: { cookie: 'maestro_pin=12345678' }, url: '/' }, '12345678')).toBe(true)
  })
})
