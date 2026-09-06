import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accessLogPath, logAccess, pruneOldAccessLogs, rotateAccessLogIfNeeded } from '../src/host/access-log.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'access-log-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('rotateAccessLogIfNeeded', () => {
  it('does nothing when the file does not exist', async () => {
    const path = join(dir, 'access.log')
    await expect(rotateAccessLogIfNeeded(path, 10, 3)).resolves.toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('does nothing when the file is under the size limit', async () => {
    const path = join(dir, 'access.log')
    await writeFile(path, 'short\n')
    await rotateAccessLogIfNeeded(path, 1024, 3)
    expect(await readFile(path, 'utf8')).toBe('short\n')
    expect(existsSync(`${path}.1`)).toBe(false)
  })

  it('rotates the live file to .1 once it reaches the size limit', async () => {
    const path = join(dir, 'access.log')
    await writeFile(path, 'x'.repeat(20))
    await rotateAccessLogIfNeeded(path, 10, 3)
    expect(existsSync(path)).toBe(false)
    expect(await readFile(`${path}.1`, 'utf8')).toBe('x'.repeat(20))
  })

  it('shifts existing backups up and drops anything past maxBackups', async () => {
    const path = join(dir, 'access.log')
    await writeFile(path, 'current'.padEnd(20, 'x'))
    await writeFile(`${path}.1`, 'backup-1')
    await writeFile(`${path}.2`, 'backup-2')
    await rotateAccessLogIfNeeded(path, 10, 2)
    expect(existsSync(path)).toBe(false)
    expect(await readFile(`${path}.1`, 'utf8')).toBe('current'.padEnd(20, 'x'))
    expect(await readFile(`${path}.2`, 'utf8')).toBe('backup-1')
    // backup-2 was the oldest allowed by maxBackups=2 and is dropped, not kept as .3
    expect(existsSync(`${path}.3`)).toBe(false)
  })
})

describe('pruneOldAccessLogs', () => {
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000

  it('deletes the live file and backups older than maxAgeMs', async () => {
    const path = join(dir, 'access.log')
    const now = Date.now()
    await writeFile(path, 'old-current')
    await writeFile(`${path}.1`, 'old-backup')
    const old = new Date(now - oneWeekMs - 1000)
    await utimes(path, old, old)
    await utimes(`${path}.1`, old, old)

    await pruneOldAccessLogs(path, oneWeekMs, now)

    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.1`)).toBe(false)
  })

  it('keeps files at or under maxAgeMs', async () => {
    const path = join(dir, 'access.log')
    const now = Date.now()
    await writeFile(path, 'fresh-current')
    const fresh = new Date(now - 1000)
    await utimes(path, fresh, fresh)

    await pruneOldAccessLogs(path, oneWeekMs, now)

    expect(existsSync(path)).toBe(true)
  })

  it('does nothing when the log directory does not exist yet', async () => {
    const path = join(dir, 'missing-dir', 'access.log')
    await expect(pruneOldAccessLogs(path, oneWeekMs)).resolves.toBeUndefined()
  })

  it('ignores unrelated files in the same directory', async () => {
    const path = join(dir, 'access.log')
    const now = Date.now()
    const unrelated = join(dir, 'other-file.txt')
    await writeFile(unrelated, 'unrelated')
    const old = new Date(now - oneWeekMs - 1000)
    await utimes(unrelated, old, old)

    await pruneOldAccessLogs(path, oneWeekMs, now)

    expect(existsSync(unrelated)).toBe(true)
  })
})

describe('logAccess', () => {
  it('appends one JSON line with a time field and the given entry', async () => {
    process.env.DSH_HOME = dir
    try {
      await logAccess({ kind: 'http', method: 'GET', url: '/', status: 200 })
      const path = accessLogPath()
      const lines = (await readFile(path, 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(1)
      const parsed = JSON.parse(lines[0] as string)
      expect(parsed).toMatchObject({ kind: 'http', method: 'GET', url: '/', status: 200 })
      expect(typeof parsed.time).toBe('string')
    } finally {
      delete process.env.DSH_HOME
    }
  })

  it('never throws when the target path cannot be created', async () => {
    process.env.DSH_HOME = join(dir, 'access.log', 'not-a-directory')
    try {
      await writeFile(join(dir, 'access.log'), 'blocks mkdir from creating a dir at this path')
      await expect(logAccess({ kind: 'http' })).resolves.toBeUndefined()
    } finally {
      delete process.env.DSH_HOME
    }
  })
})
