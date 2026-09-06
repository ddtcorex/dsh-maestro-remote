import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Diagnostic access log: every request/WebSocket upgrade through the remote
 * proxy, appended as JSON lines to `~/.dsh/dsh-maestro-remote/logs/access.log`.
 * Rotated by size (never unbounded) so it stays useful for tracing
 * client-side stalls that leave no error in the browser and no way to
 * attach a remote debugger, without growing forever on a long-lived host.
 * Never blocks or throws into request handling — a logging or rotation
 * failure is swallowed, not surfaced.
 */

/** Rotate once the live file reaches this size. */
export const ACCESS_LOG_MAX_BYTES = 5 * 1024 * 1024

/** Number of rotated backups kept (`access.log.1` is newest, `.N` oldest). */
export const ACCESS_LOG_MAX_BACKUPS = 3

export function accessLogPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-maestro-remote', 'logs', 'access.log')
}

/**
 * Shift `path` -> `path.1` -> `path.2` ... -> `path.N`, dropping anything
 * older than `maxBackups`, when `path` is at or over `maxBytes`. A missing
 * source at any shift step is not an error — the backup chain may not be
 * full yet.
 */
export async function rotateAccessLogIfNeeded(
  path: string,
  maxBytes: number = ACCESS_LOG_MAX_BYTES,
  maxBackups: number = ACCESS_LOG_MAX_BACKUPS,
): Promise<void> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return
  }
  if (size < maxBytes) return
  for (let i = maxBackups; i >= 1; i -= 1) {
    const from = i === 1 ? path : `${path}.${i - 1}`
    const to = `${path}.${i}`
    try {
      await rename(from, to)
    } catch {
      // No file at this shift step yet — the backup chain isn't full yet.
    }
  }
}

/** Delete a live or rotated access log older than this. */
export const ACCESS_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** How often {@link logAccess} re-checks file ages, to avoid a directory scan on every request. */
const PRUNE_CHECK_INTERVAL_MS = 60 * 60 * 1000

let lastPruneCheck = 0

/**
 * Delete `path` and any of its rotated backups (`path.1`, `path.2`, ...)
 * whose last-modified time is older than `maxAgeMs`. A file that vanishes
 * between listing and stat/unlink (rotated or pruned concurrently) is not
 * an error.
 */
export async function pruneOldAccessLogs(
  path: string,
  maxAgeMs: number = ACCESS_LOG_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<void> {
  const dir = dirname(path)
  const base = basename(path)
  let entries: readonly string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry !== base && !entry.startsWith(`${base}.`)) continue
    const full = join(dir, entry)
    try {
      const info = await stat(full)
      if (now - info.mtimeMs > maxAgeMs) await unlink(full)
    } catch {
      // Vanished between listing and stat/unlink — nothing left to prune.
    }
  }
}

export async function logAccess(entry: Record<string, unknown>): Promise<void> {
  try {
    const path = accessLogPath()
    await mkdir(dirname(path), { recursive: true })
    await rotateAccessLogIfNeeded(path)
    const now = Date.now()
    if (now - lastPruneCheck >= PRUNE_CHECK_INTERVAL_MS) {
      lastPruneCheck = now
      await pruneOldAccessLogs(path, ACCESS_LOG_MAX_AGE_MS, now)
    }
    await appendFile(path, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
  } catch {
    // Diagnostic-only: a log write failure must never affect request handling.
  }
}
