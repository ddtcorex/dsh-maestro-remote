// vendored from dsh-maestro-core store, sha256:ca062c527bb30c030c086751be275ee379071f33691568ff7d0eae4372012829
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { mkdir, open, readFile, rename, unlink, stat, rm, writeFile, link } from 'node:fs/promises'
import { mkdirSync, readFileSync } from 'node:fs'
import { watch, type FSWatcher } from 'node:fs'

export interface SettingsDoc {
  version: 1
  domains: Record<string, unknown>
}

/** Minimal structural validator a domain owner supplies (schemastery/zod adapters fit). */
export interface DomainValidator {
  parse(value: unknown): { ok: true; value?: unknown } | { ok: false; error: string }
}

const EMPTY_DOC: SettingsDoc = { version: 1, domains: {} }

const domainValidators = new Map<string, DomainValidator>()
const changeCbs = new Set<(domain: string) => void>()

/**
 * Identity of the settings file a cached document was read from. mtime alone is
 * not enough: two copies writing within one filesystem timestamp tick, or an
 * editor that restores the mtime, would leave a stale document in the cache.
 * Every store write is a temp file + rename, so a changed inode is the reliable
 * signal; size catches an in-place edit that kept the mtime.
 */
interface FileSig { mtimeMs: number; ino: number; size: number }

let cached: { key: string; doc: SettingsDoc; sig: FileSig | null } | null = null

async function fileSig(path: string): Promise<FileSig | null> {
  try {
    const st = await stat(path)
    return { mtimeMs: st.mtimeMs, ino: st.ino, size: st.size }
  } catch {
    return null
  }
}

function sameSig(a: FileSig | null, b: FileSig | null): boolean {
  return a !== null && b !== null && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.size === b.size
}

function resolveDshHome(explicit?: string): string {
  return explicit ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function storePath(opts?: { dshHome?: string }): string {
  return join(resolveDshHome(opts?.dshHome), 'dsh-maestro-config', 'settings.json')
}

/** Register a validator for a domain you own. Writes to it are validated on every set(). */
export function defineDomain(name: string, validator: DomainValidator): void {
  domainValidators.set(name, validator)
}

// ---------------------------------------------------------------------------
// change notification
// ---------------------------------------------------------------------------

/**
 * Every plugin embeds its own copy of this module, so a listener has to hear
 * writes made by another copy (or by another process), not only writes made
 * through the copy that owns it. While at least one listener exists we watch
 * the settings file and compare every domain against `snapshot`; a local write
 * refreshes `snapshot` before it fires the callbacks, so it never fires twice.
 *
 * The watcher resolves DSH_HOME once, when it starts. A store pinned to an
 * explicit `dshHome` therefore stays out of the watched home and neither fires
 * nor receives notifications for writes that go somewhere else.
 */
const WATCH_DEBOUNCE_MS = 50
const POLL_MS = 2_000
const FILE_BASENAME = 'settings.json'

let watcher: FSWatcher | null = null
let pollTimer: NodeJS.Timeout | null = null
let debounceTimer: NodeJS.Timeout | null = null
let snapshot: Record<string, string> = {}
let watchedHome: string | null = null
let checking = false

/** JSON text per domain, so a value change is a cheap string comparison. */
function fingerprint(doc: SettingsDoc): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [domain, value] of Object.entries(doc.domains)) {
    out[domain] = JSON.stringify(value) ?? 'undefined'
  }
  return out
}

/**
 * Seed the snapshot synchronously so a write racing `onChange` cannot slip
 * between "listener registered" and "snapshot taken" and go unnoticed.
 */
function readSnapshotSync(home: string): Record<string, string> {
  try {
    return fingerprint(parseDoc(readFileSync(storePath({ dshHome: home }), 'utf8')))
  } catch {
    return {} // no store on disk yet: every domain is new
  }
}

/**
 * Run every listener for one domain. Each callback gets its own try/catch: a
 * throwing listener must neither reject the write that already committed nor
 * hide the change from the listeners registered after it.
 */
function fire(domain: string): void {
  for (const cb of [...changeCbs]) {
    try {
      cb(domain)
    } catch (err) {
      console.warn(`config-lib: onChange callback for '${domain}' threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

async function checkExternal(): Promise<void> {
  if (changeCbs.size === 0 || watchedHome === null || checking) return
  checking = true
  try {
    // load() invalidates its own cache on an mtime change, so this sees other
    // writers' values without an extra stat.
    const next = fingerprint(await load({ dshHome: watchedHome }))
    const changed: string[] = []
    for (const domain of new Set([...Object.keys(snapshot), ...Object.keys(next)])) {
      // A domain that disappeared compares against undefined and counts as changed.
      if (snapshot[domain] !== next[domain]) changed.push(domain)
    }
    snapshot = next
    for (const domain of changed) fire(domain)
  } catch {
    // A transient read failure must never break boot; the next tick retries.
  } finally {
    checking = false
  }
}

function scheduleCheck(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void checkExternal()
  }, WATCH_DEBOUNCE_MS)
  debounceTimer.unref()
}

function stopWatching(): void {
  watcher?.close()
  watcher = null
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  snapshot = {}
  watchedHome = null
}

function startWatching(): void {
  if (watcher || pollTimer) return
  const home = resolveDshHome()
  const path = storePath({ dshHome: home })
  watchedHome = home
  snapshot = readSnapshotSync(home)
  try {
    // fs.watch is not recursive, so it only sees the file when its own
    // directory exists; the store is the only writer of that path either way.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const w = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename === null || filename === FILE_BASENAME) scheduleCheck()
    })
    // An unhandled 'error' event (EMFILE, directory removed, ...) would crash
    // the host. Drop the watcher and let the poll below carry on alone.
    w.on('error', () => {
      try { w.close() } catch { /* already closed */ }
      if (watcher === w) watcher = null
    })
    watcher = w
  } catch {
    watcher = null // polling below still covers the change
  }
  pollTimer = setInterval(() => void checkExternal(), POLL_MS)
  pollTimer.unref()
}

/** Fire callbacks registered through this instance after a successful set(). */
export function onChange(cb: (domain: string) => void): () => void {
  changeCbs.add(cb)
  startWatching()
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    changeCbs.delete(cb)
    if (changeCbs.size === 0) stopWatching()
  }
}

/** Test seam: drop the memoized document and listeners (schemas are kept). */
export function resetForTests(): void {
  cached = null
  changeCbs.clear()
  stopWatching()
}

// ---------------------------------------------------------------------------
// locking + io
// ---------------------------------------------------------------------------

/**
 * Lock timing. A lock is only stolen once it is older than STALE_MS, which is
 * deliberately longer than the time a waiter is willing to wait: a live writer
 * that is merely slow must time its waiters out, never get robbed.
 */
const LOCK_TIMEOUT_MS = 5_000
const LOCK_STALE_MS = 30_000

/** Settings directory: created 0700, lock file 0600 (the settings file is 0600 too). Modes apply at creation only; existing paths are never chmod-ed. */
const DIR_MODE = 0o700
const FILE_MODE = 0o600

/**
 * Move a stale lock aside and delete it. rename() is atomic, so of several
 * waiters only one moves the file. If the moved file turns out not to be the
 * one we judged stale (a new owner took the path between our stat and the
 * rename), it is put back with link(), which refuses to overwrite.
 */
async function stealStaleLock(lockPath: string, observedIno: number): Promise<void> {
  const aside = `${lockPath}.stale-${randomBytes(4).toString('hex')}`
  try {
    await rename(lockPath, aside)
  } catch {
    return // someone else removed or stole it first
  }
  try {
    const moved = await stat(aside)
    if (moved.ino !== observedIno) await link(aside, lockPath).catch(() => {})
  } catch {
    /* nothing to restore */
  } finally {
    await rm(aside, { force: true }).catch(() => {})
  }
}

async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE }) // the store dir may not exist on first write
  const lockPath = `${path}.lock`
  const token = `${process.pid}-${randomBytes(8).toString('hex')}`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', FILE_MODE)
      try {
        await handle.writeFile(token)
      } finally {
        await handle.close()
      }
      break
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err
      // Break stale locks left behind by a crashed writer.
      try {
        const st = await stat(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await stealStaleLock(lockPath, st.ino)
          continue
        }
      } catch {
        /* lock vanished between stat and now — just retry */
      }
      if (Date.now() > deadline) throw new Error(`config-lib: lock timeout at ${lockPath}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  try {
    return await fn()
  } finally {
    // Only release a lock that is still ours: if it was stolen and re-acquired
    // meanwhile, deleting it would break the new owner's mutual exclusion.
    try {
      if ((await readFile(lockPath, 'utf8')) === token) await unlink(lockPath)
    } catch {
      /* already gone */
    }
  }
}

function parseDoc(raw: string): SettingsDoc {
  const parsed = JSON.parse(raw) as Partial<SettingsDoc>
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.version !== 'number') {
    throw new Error('config-lib: malformed settings document')
  }
  return { version: 1, domains: (parsed.domains as Record<string, unknown>) ?? {} }
}

async function readDoc(path: string): Promise<SettingsDoc> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { ...EMPTY_DOC, domains: {} }
    throw err
  }
  return parseDoc(raw)
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (
    base !== null && typeof base === 'object' && !Array.isArray(base) &&
    patch !== null && typeof patch === 'object' && !Array.isArray(patch)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      out[k] = k in out ? deepMerge(out[k], v) : v
    }
    return out
  }
  return patch
}

async function writeDocLocked(path: string, doc: SettingsDoc): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  const tmp = `${path}.tmp-${Math.random().toString(16).slice(2, 10)}`
  try {
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: FILE_MODE })
    await rename(tmp, path) // atomic on the same filesystem; rename carries the 600 mode
  } finally {
    // After a successful rename the temp name is gone and this is a no-op; after
    // a failed write or rename it removes the orphan instead of leaking one per try.
    await rm(tmp, { force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export async function load(opts?: { dshHome?: string }): Promise<SettingsDoc> {
  const path = storePath(opts)
  const homeKey = resolveDshHome(opts?.dshHome)
  if (cached && cached.key === homeKey) {
    // One stat per load: out-of-band edits (other processes) must surface
    // without a restart.
    const now = await fileSig(path)
    if (now === null) return cached.doc // stat failed (vanished/locked) — serve stale, never break boot
    if (sameSig(now, cached.sig)) return cached.doc
  }
  const doc = await readDoc(path)
  cached = { key: homeKey, doc, sig: await fileSig(path) }
  return doc
}

export async function get(domain: string, opts?: { dshHome?: string }): Promise<unknown> {
  const doc = await load(opts)
  return doc.domains[domain]
}

export async function set(
  domain: string,
  patch: object,
  opts?: { dshHome?: string },
): Promise<void> {
  const path = storePath(opts)
  const key = resolveDshHome(opts?.dshHome)
  let written: unknown
  await withLock(path, async () => {
    const doc = await readDoc(path)
    const validator = domainValidators.get(domain)
    const merged = deepMerge(doc.domains[domain], patch)
    if (validator) {
      const res = validator.parse(merged)
      if (!res.ok) throw new Error(`config-lib: validation failed for '${domain}': ${res.error}`)
    }
    doc.domains[domain] = merged
    written = merged
    await writeDocLocked(path, doc)
    cached = { key, doc, sig: await fileSig(path) }
  })
  // Refresh the watched copy first so the watcher sees no diff for this write.
  if (watchedHome === key) snapshot[domain] = JSON.stringify(written) ?? 'undefined'
  fire(domain)
}

/**
 * Delete one TOP-LEVEL key of a domain — the delete operation `set()` cannot
 * express (a merge patch has no delete signal: `null` persists as null).
 * Dotted paths are rejected to keep the semantics exactly one key. No-op
 * (`false`, no write, no callbacks) when the domain is absent/not an object
 * or the key is absent. Otherwise the resulting domain is validated like a
 * `set()` before the atomic write; `true` means the key is gone.
 */
export async function unset(
  domain: string,
  key: string,
  opts?: { dshHome?: string },
): Promise<boolean> {
  if (typeof key !== 'string' || key === '' || key.includes('.')) {
    throw new Error(`config-lib: unset key must be a top-level name, got ${JSON.stringify(key)}`)
  }
  const path = storePath(opts)
  const homeKey = resolveDshHome(opts?.dshHome)
  let written: Record<string, unknown> | undefined
  const deleted = await withLock(path, async () => {
    const doc = await readDoc(path)
    const bucket = doc.domains[domain]
    if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) return false
    if (!(key in bucket)) return false
    const next = { ...(bucket as Record<string, unknown>) }
    delete next[key]
    const validator = domainValidators.get(domain)
    if (validator) {
      const res = validator.parse(next)
      if (!res.ok) throw new Error(`config-lib: validation failed for '${domain}': ${res.error}`)
    }
    doc.domains[domain] = next
    written = next
    await writeDocLocked(path, doc)
    cached = { key: homeKey, doc, sig: await fileSig(path) }
    return true
  })
  if (deleted) {
    if (watchedHome === homeKey) snapshot[domain] = JSON.stringify(written) ?? 'undefined'
    fire(domain)
  }
  return deleted
}

/** Names of domains registered via defineDomain (schema owners). */
export function definedDomains(): string[] {
  return [...domainValidators.keys()]
}

// ---------------------------------------------------------------------------
// flat-key adapter map (live: remote/review/supervisor read through readFlat)
// ---------------------------------------------------------------------------

export const DOMAIN_KEY_MAP: Record<string, string> = {
  gitlabBaseUrl: 'gitlab.baseUrl',
  gitlabToken: 'gitlab.token',
  botUsername: 'gitlab.botUsername',
  webhookSecret: 'gitlab.webhookSecret',
  webhookPort: 'gitlab.webhookPort',
  projectMappings: 'gitlab.projectMappings',
  autoRereviewOnPush: 'gitlab.autoRereviewOnPush',
  autoReviewOnAssign: 'gitlab.autoReviewOnAssign',
  reviewModel: 'review.model',
  agentTimeoutMs: 'review.agentTimeoutMs',
  reviewSessionRetentionDays: 'review.sessionRetentionDays',
  tunnelHostname: 'tunnel.hostname',
  tunnelCredentialsFile: 'tunnel.credentialsFile',
  tunnelId: 'tunnel.id',
  tunnelMode: 'tunnel.mode',
  quickTarget: 'tunnel.quickTarget',
  proxyPort: 'tunnel.proxyPort',
  proxyHost: 'tunnel.proxyHost',
  lanPinEnabled: 'tunnel.lanPinEnabled',
  lanPort: 'tunnel.lanPort',
  lanHost: 'tunnel.lanHost',
  /** Login-cookie lifetime in hours for the remote PIN gate (0 = session cookie). */
  pinSessionTtlHours: 'tunnel.pinSessionTtlHours',
  telegramBotToken: 'notifier.telegram.botToken',
  telegramChatId: 'notifier.telegram.chatId',
  telegramReviewNotifications: 'notifier.policy.reviewNotifications',
}

/** Machine runtime state — never settings; owning adapters persist these in their own sidecar. */
export const RUNTIME_KEYS: readonly string[] = ['lastTunnelRunning']

function setIn(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.')
  let cur = obj
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {}
    cur = cur[part] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

// ---------------------------------------------------------------------------
// adapter helpers — one mapping source for consumer config-stores
// ---------------------------------------------------------------------------

export interface DomainWrite {
  domain: string
  patch: Record<string, unknown>
}

/** Route a flat legacy-keyed patch into per-domain writes; runtime keys are skipped. */
export function splitLegacyPatch(patch: Record<string, unknown>): DomainWrite[] {
  const byDomain = new Map<string, Record<string, unknown>>()
  for (const [key, value] of Object.entries(patch)) {
    if (RUNTIME_KEYS.includes(key)) continue
    const dotted = DOMAIN_KEY_MAP[key]
    if (!dotted) continue
    const domain = dotted.split('.')[0]
    const group = byDomain.get(domain) ?? {}
    setIn(group, dotted.slice(domain.length + 1), value)
    byDomain.set(domain, group)
  }
  return [...byDomain].map(([domain, patch]) => ({ domain, patch }))
}

/** Write a flat legacy-keyed patch through the domain store (multiple atomic set()s). */
export async function writeLegacyPatch(
  patch: Record<string, unknown>,
  opts?: { dshHome?: string },
): Promise<void> {
  for (const { domain, patch: group } of splitLegacyPatch(patch)) {
    await set(domain, group, opts)
  }
}

/** Inverse view: domains flattened back into legacy key names (undefined keys omitted). */
export async function readFlat(opts?: { dshHome?: string }): Promise<Record<string, unknown>> {
  const doc = await load(opts)
  const flat: Record<string, unknown> = {}
  for (const [key, dotted] of Object.entries(DOMAIN_KEY_MAP)) {
    let cur: unknown = doc.domains
    for (const part of dotted.split('.')) {
      if (cur !== null && typeof cur === 'object') cur = (cur as Record<string, unknown>)[part]
      else { cur = undefined; break }
    }
    if (cur !== undefined) flat[key] = cur
  }
  return flat
}
