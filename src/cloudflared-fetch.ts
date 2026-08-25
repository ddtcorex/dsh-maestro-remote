import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/** cloudflared release-asset coordinates for the running platform. */
export interface PlatformBinary {
  os: 'darwin' | 'windows' | 'linux'
  arch: 'amd64' | 'arm64' | string
  ext: '' | '.exe' | string
}

const ARCH_MAP: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }

/** Map node's process.platform/process.arch onto cloudflared asset names. */
export function platformBinary(platform: NodeJS.Platform = process.platform, arch: string = process.arch): PlatformBinary {
  const os = platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux'
  return { os, arch: ARCH_MAP[arch] ?? arch, ext: os === 'windows' ? '.exe' : '' }
}

export interface CloudflaredFetchInternals {
  /** Whether a `cloudflared` command already exists on PATH. */
  commandOnPath: () => boolean
  fetch: typeof fetch
  platform: PlatformBinary
  spawnTar?: typeof spawn
}

export interface ResolveCloudflaredOptions {
  /** `$DSH_HOME` — the cache lives at `<home>/dsh-maestro-remote/bin/`. */
  home?: string
  signal?: AbortSignal
  onPhase?: (phase: 'downloading') => void
  internals?: Partial<CloudflaredFetchInternals>
}

/**
 * Ordered download sources. TUNA (a domestic CDN) is prepended first when it
 * has a usable bottle; GitHub official follows, then community accelerators.
 */
const GITHUB_MIRRORS = [
  (asset: string) => `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset: string) => `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset: string) => `https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset: string) => `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
]

const TUNA_BOTTLES = 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/'

// Parallel-download tuning (values proven in dsh-pocket production):
// files below MIN_PARALLEL_SIZE never fan out; a PROBE_SIZE single-thread
// sample measures link speed and only slow links switch to SEGMENTS ranges.
const SEGMENTS = 8
const MIN_PARALLEL_SIZE = 8 * 1024 * 1024
const PROBE_SIZE = 2 * 1024 * 1024
/** Probe speed in bytes/ms below which the download fans out into segments. */
const SLOW_THRESHOLD = 0.3

interface DownloadTuning {
  segments: number
  minParallelSize: number
  probeSize: number
  /** Probe elapsed-time floor: probes faster than this are fast without measuring speed. */
  fastFloorMs: number
  slowThreshold: number
}

const DEFAULT_TUNING: DownloadTuning = {
  segments: SEGMENTS,
  minParallelSize: MIN_PARALLEL_SIZE,
  probeSize: PROBE_SIZE,
  fastFloorMs: 500,
  slowThreshold: SLOW_THRESHOLD,
}
function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url }
}

/**
 * TUNA Homebrew-bottle URL for cloudflared, newest version for the CPU
 * architecture. macOS only — Linux bottles ship an ELF whose interpreter is
 * the literal `@@HOMEBREW_PREFIX@@` placeholder and cannot run outside
 * Homebrew. Returns null when the listing is unreachable or has no match; the
 * caller then falls back to the GitHub mirrors.
 */
export async function tsinghuaBottleUrl(
  { os, arch }: Pick<PlatformBinary, 'os' | 'arch'>,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (os !== 'darwin') return null
  let res: Response
  try {
    res = await fetchImpl(TUNA_BOTTLES, { signal: AbortSignal.timeout(20_000) })
  } catch { return null }
  if (!res.ok) return null
  let html: string
  try { html = await res.text() } catch { return null }
  const codes = 'monterey|ventura|sonoma|sequoia|tahoe'
  const prefix = arch === 'arm64' ? 'arm64_' : ''
  const pattern = new RegExp(`cloudflared-([0-9.]+)\\.${prefix}(${codes})\\.bottle\\.tar\\.gz`, 'g')
  let best: string | null = null
  let bestVersion = ''
  for (const match of html.matchAll(pattern)) {
    if (match[1] > bestVersion) { bestVersion = match[1]; best = match[0] }
  }
  return best === null ? null : `${TUNA_BOTTLES}${best}`
}

async function mergeParts(partFiles: string[], dest: string): Promise<void> {
  const out = createWriteStream(dest)
  try {
    for (const file of partFiles) {
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(file)
        rs.on('error', reject)
        rs.pipe(out, { end: false })
        rs.on('end', () => resolve())
      })
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }
}

/**
 * Adaptive download: single-threaded when the server lacks byte ranges or the
 * file is small; a probe sample measures speed on range-capable servers and
 * slow links retry as parallel Range segments that are merged afterwards.
 * Returns the total byte count advertised by the server.
 */
export async function downloadFile(
  url: string,
  dest: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number } & Partial<DownloadTuning> = {},
): Promise<number> {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const tuning = { ...DEFAULT_TUNING, ...options }
  const head = await fetchImpl(url, { method: 'HEAD', signal: options.signal }).catch(() => null)
  const length = Number(head?.headers.get('content-length') ?? 0)
  const acceptsRanges = String(head?.headers.get('accept-ranges') ?? '').toLowerCase() === 'bytes'

  if (head === null || !acceptsRanges || length < tuning.minParallelSize) {
    const res = await fetchImpl(url, { signal: options.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
    return length || 0
  }

  // Probe: download the first probeSize bytes single-threaded and time it.
  const probeBytes = Math.min(tuning.probeSize, length)
  const probeStart = now()
  try {
    const probeRes = await fetchImpl(url, { signal: options.signal, headers: { Range: `bytes=0-${probeBytes - 1}` } })
    if (!probeRes.ok) throw new Error(`HTTP ${probeRes.status} (probe)`)
    const probeBody = Buffer.from(await probeRes.arrayBuffer())
    const probeMs = now() - probeStart
    const probeSpeed = probeMs > 0 ? probeBody.length / probeMs : Number.POSITIVE_INFINITY
    if (probeMs < tuning.fastFloorMs || probeSpeed >= tuning.slowThreshold) {
      // Fast link: keep the probe bytes and stream the remainder single-threaded.
      await pipeline(
        (async function* () { yield probeBody })() as never,
        createWriteStream(dest),
      )
      const restRes = await fetchImpl(url, { signal: options.signal, headers: { Range: `bytes=${probeBytes}-${length - 1}` } })
      if (!restRes.ok) throw new Error(`HTTP ${restRes.status} (rest)`)
      await pipeline(Readable.fromWeb(restRes.body as never), createWriteStream(dest, { flags: 'a' }))
      return length
    }
    // Slow link: discard the probe and restart as parallel segments.
    await rm(dest, { force: true }).catch(() => {})
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {})
    if (!/HTTP|fetch/i.test(String((err as Error | undefined)?.message ?? ''))) throw err
    // Probe HTTP mismatch (some CDNs treat HEAD and GET differently) → segment directly.
  }

  const chunk = Math.ceil(length / tuning.segments)
  const parts: Array<{ start: number; end: number; file: string }> = []
  for (let i = 0; i < tuning.segments; i++) {
    const start = i * chunk
    const end = i === tuning.segments - 1 ? length - 1 : Math.min(start + chunk - 1, length - 1)
    if (start > end) break
    parts.push({ start, end, file: `${dest}.part${i}` })
  }
  try {
    await Promise.all(parts.map(async (part) => {
      const res = await fetchImpl(url, { signal: options.signal, headers: { Range: `bytes=${part.start}-${part.end}` } })
      if (!res.ok) throw new Error(`HTTP ${res.status} (range ${part.start}-${part.end})`)
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part.file))
    }))
    await mergeParts(parts.map((p) => p.file), dest)
  } finally {
    await Promise.all(parts.map((p) => rm(p.file, { force: true }).catch(() => {})))
  }
  return length
}

function extractTarArchive(tarPath: string, extractDir: string, spawnFn: typeof spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawnFn('tar', ['-xzf', tarPath, '-C', extractDir], { stdio: 'ignore' })
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`cloudflared extraction failed (code=${code})`))))
    child.once('error', reject)
  })
}

/**
 * Download cloudflared through every source until one succeeds, then unpack:
 * Windows assets are plain executables, macOS/Linux assets are tarballs whose
 * real binary may sit at the root (GitHub tgz) or under `<version>/bin/`
 * (Homebrew bottle layout). Files smaller than 1MB are rejected outright —
 * mirrors sometimes answer with an error page.
 */
async function downloadCloudflared(
  binPath: string,
  internals: CloudflaredFetchInternals,
  signal?: AbortSignal,
): Promise<string> {
  const { os, arch, ext } = internals.platform
  const dir = dirname(binPath)
  const tmpFile = join(dir, 'cloudflared.download')
  const asset = os === 'windows' ? `cloudflared-windows-${arch}.exe` : `cloudflared-${os}-${arch}.tgz`

  const sources: Array<{ url: string; host: string }> = []
  if (os !== 'windows') {
    const tuna = await tsinghuaBottleUrl({ os, arch }, internals.fetch).catch(() => null)
    if (tuna !== null) sources.push({ url: tuna, host: hostOf(tuna) })
  }
  for (const mirror of GITHUB_MIRRORS) sources.push({ url: mirror(asset), host: hostOf(mirror(asset)) })

  let lastError: Error | undefined
  for (const source of sources) {
    try {
      await downloadFile(source.url, tmpFile, { signal, fetch: internals.fetch })
      const info = await stat(tmpFile)
      if (info.size < 1024 * 1024) throw new Error(`suspiciously small file (${info.size} bytes) — likely a mirror error page`)
      lastError = undefined
      break
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      await rm(tmpFile, { force: true }).catch(() => {})
    }
  }
  if (lastError !== undefined) {
    throw new Error(
      `cloudflared download failed on all sources (${lastError.message}). `
      + `Install it manually and retry: npm i -g cloudflared (any platform), winget install cloudflared (Windows), brew install cloudflared (macOS); `
      + `or place the binary at ${binPath}`,
    )
  }

  if (os === 'windows') {
    await rename(tmpFile, binPath).catch(async () => { await rm(binPath, { force: true }).catch(() => {}); await import('node:fs/promises').then((fs) => fs.copyFile(tmpFile, binPath)) })
  } else {
    const extractDir = join(dir, `.extract-${process.pid}-${Date.now()}`)
    await mkdir(extractDir, { recursive: true })
    try {
      await extractTarArchive(tmpFile, extractDir, internals.spawnTar ?? spawn)
      const direct = join(extractDir, `cloudflared${ext}`)
      let found: string | null = null
      if ((await stat(direct).then((s) => s.isFile()).catch(() => false))) found = direct
      if (found === null) {
        const versionDir = join(extractDir, 'cloudflared')
        const versions = await import('node:fs/promises').then((fs) => fs.readdir(versionDir)).catch(() => [] as string[])
        for (const version of versions) {
          const candidate = join(versionDir, version, 'bin', `cloudflared${ext}`)
          if ((await stat(candidate).then((s) => s.isFile()).catch(() => false))) { found = candidate; break }
        }
      }
      if (found === null) throw new Error('cloudflared extracted but no binary found inside the archive')
      if (found !== binPath) {
        await rename(found, binPath).catch(async () => { await rm(binPath, { force: true }).catch(() => {}); await import('node:fs/promises').then((fs) => fs.copyFile(found!, binPath)) })
      }
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {})
    }
    await chmod(binPath, 0o755).catch(() => {})
  }
  await rm(tmpFile, { force: true }).catch(() => {})
  return binPath
}

/** Single in-flight download shared by concurrent resolutions of the same cache. */
let downloading: Promise<string> | null = null

/**
 * Return a runnable cloudflared: the PATH command when present, else the
 * persistent cache under `<home>/dsh-maestro-remote/bin/`, downloading it
 * through the mirror chain only when the cache is missing. A cached Linux ELF
 * carrying the unusable Homebrew `@@HOMEBREW_PREFIX@@` interpreter placeholder
 * is discarded so the re-download replaces it.
 */
export async function resolveCloudflared(options: ResolveCloudfreredOptionsAlias = {}): Promise<string> {
  const internals: CloudflaredFetchInternals = {
    commandOnPath: options.internals?.commandOnPath ?? (() => {
      try {
        execSync(process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' })
        return true
      } catch { return false }
    }),
    fetch: options.internals?.fetch ?? fetch,
    platform: options.internals?.platform ?? platformBinary(),
    ...(options.internals?.spawnTar !== undefined ? { spawnTar: options.internals.spawnTar } : {}),
  }
  if (internals.commandOnPath()) return 'cloudflared'

  const dshHome = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const cacheDir = join(dshHome, 'dsh-maestro-remote', 'bin')
  const { os, arch, ext } = internals.platform
  // Accept both our own cache name and a manually placed release-asset name.
  const candidates = [join(cacheDir, `cloudflared${ext}`), join(cacheDir, `cloudflared-${os}-${arch}${ext}`)]
  for (const bin of candidates) {
    const usable = await import('node:fs/promises').then(async (fs) => {
      await fs.access(bin)
      if (os === 'linux') {
        const handle = await open(bin, 'r')
        try {
          const head = Buffer.alloc(8192)
          await handle.read(head, 0, 8192, 0)
          if (head.includes('@@HOMEBREW_PREFIX@@')) return null
        } finally { await handle.close() }
      }
      return bin
    }).catch(() => null)
    if (usable !== null) return usable
    if (usable === null && candidates.indexOf(bin) === 0 && os === 'linux') {
      await rm(bin, { force: true }).catch(() => {})
    }
  }

  options.onPhase?.('downloading')
  await mkdir(cacheDir, { recursive: true })
  downloading ??= downloadCloudflared(join(cacheDir, `cloudflared${ext}`), internals, options.signal).finally(() => { downloading = null })
  return downloading
}

type ResolveCloudfreredOptionsAlias = ResolveCloudflaredOptions
