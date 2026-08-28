import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinPath, readPin } from '../src/host/pin-store.ts'

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

  it('readPin migrates legacy token file when pin missing', async () => {
    // legacy file
    const legacy = join(home, 'dsh-maestro-remote', 'token')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'dsh-maestro-remote'), { recursive: true })
    await writeFile(legacy, '12345678', 'utf-8')
    const pin = await readPin()
    expect(pin).toBe('12345678')
    // migrated to new location
    const fresh = (await readFile(join(home, 'dsh-maestro-remote', 'pin'), 'utf-8')).trim()
    expect(fresh).toBe('12345678')
  })

  it('readPin does NOT accept ?pin= query — only cookie (checked via isPinAuthorized)', async () => {
    const { isPinAuthorized } = await import('../src/host/remote-proxy.ts')
    // query pin should NOT authorize, only cookie should
    expect(isPinAuthorized({ headers: {}, url: '/?pin=12345678' }, '12345678')).toBe(false)
    expect(isPinAuthorized({ headers: { cookie: 'maestro_pin=12345678' }, url: '/' }, '12345678')).toBe(true)
  })
})
