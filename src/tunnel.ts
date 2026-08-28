import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { loadUserConfig, saveUserConfig } from './config-store.js'
import { readPin, readLanPin, rotatePin, rotateLanPin } from './pin-store.js'
import { createRemoteProxy, isPublicHost, lanUrls, type RemoteProxyHandle } from './remote-proxy.js'
import { resolveCloudflared } from './cloudflared-fetch.js'
import { scheduleStartupNotification } from './startup-notify.js'

const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

export interface QuickTunnelHandle {
  url: string
  kill: () => void
  /** Register a callback fired when the cloudflared process exits; returns an unsubscriber. */
  onExit?: (callback: (code: number | null) => void) => () => void
}

export interface StartQuickTunnelOptions {
  port: number
  timeoutMs?: number
  /** `$DSH_HOME` for the persistent cloudflared binary cache. */
  home?: string
  signal?: AbortSignal
  onPhase?: (phase: 'downloading' | 'starting' | 'registering' | 'ready') => void
  /** Test seams for the cloudflared resolver. */
  internals?: {
    commandOnPath?: () => boolean
    fetch?: typeof fetch
  }
}

/**
 * Spawn a Cloudflare quick tunnel; resolves once cloudflared prints its
 * assigned URL. The binary comes from resolveCloudflared, so machines without
 * a PATH installation download it through the mirror chain into the plugin's
 * persistent cache. `--protocol http2` keeps the tunnel on TCP 443 — many
 * networks block the default QUIC transport's UDP 7844 (Cloudflare error 1033).
 */
export function startQuickTunnel({ port, timeoutMs = 30_000, home, signal, onPhase, internals }: StartQuickTunnelOptions): Promise<QuickTunnelHandle> {
  return new Promise(async (resolvePromise, rejectPromise) => {
    let bin: string
    try {
      bin = await resolveCloudflared({
        ...(home !== undefined ? { home } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(onPhase !== undefined ? { onPhase: (phase: 'downloading') => onPhase(phase) } : {}),
        ...(internals !== undefined
          ? { internals: {
              ...(internals.commandOnPath !== undefined ? { commandOnPath: internals.commandOnPath } : {}),
              ...(internals.fetch !== undefined ? { fetch: internals.fetch } : {}),
            } }
          : {}),
      })
    } catch (err) {
      rejectPromise(err instanceof Error ? err : new Error(String(err)))
      return
    }
    onPhase?.('starting')
    const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--protocol', 'http2', '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] })
    onPhase?.('registering')
    let buf = ''
    const timer = setTimeout(() => {
      cleanup()
      child.kill()
      rejectPromise(new Error(
        `cloudflared quick tunnel timed out after ${timeoutMs}ms — a proxy/VPN in TUN mode can block the tunnel; quit it and retry`,
      ))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString()
      const match = buf.match(QUICK_TUNNEL_URL_RE)
      if (match) {
        cleanup()
        onPhase?.('ready')
        resolvePromise({
          url: match[0],
          kill: () => { child.kill() },
          onExit: makeOnExit(child),
        })
      }
    }
    const onError = (err: Error): void => {
      cleanup()
      rejectPromise(new Error(`cloudflared failed to start: ${err.message}`))
    }
    function cleanup(): void {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      child.off?.('error', onError)
      // The removed listeners no longer drain the pipes; resume consumption so
      // a full pipe buffer cannot stall the cloudflared process.
      child.stdout?.resume?.()
      child.stderr?.resume?.()
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', onError)
    signal?.addEventListener('abort', () => {
      cleanup()
      child.kill()
      rejectPromise(new Error('cancelled'))
    }, { once: true })
  })
}

/** Fan child-exit events out to registered listeners. */
function makeOnExit(child: ChildProcess): (callback: (code: number | null) => void) => () => void {
  const listeners = new Set<(code: number | null) => void>()
  child.on('exit', (code) => {
    for (const listener of listeners) listener(code)
  })
  return (callback) => {
    listeners.add(callback)
    return () => { listeners.delete(callback) }
  }
}

export interface NamedTunnelConfigParams {
  dshHome: string
  tunnelId: string
  credentialsFile: string
  hostname: string
  webhookPort: number
  /** Public traffic that is not `/hooks/*` lands on the remote-access proxy. */
  proxyPort: number
}

/** Generate a local cloudflared config.yml routing /hooks/* to the webhook port, everything else to the remote-access proxy. */
export async function writeNamedTunnelConfig(params: NamedTunnelConfigParams): Promise<string> {
  const path = join(params.dshHome, 'dsh-maestro-remote', 'cloudflared-config.yml')
  const content = `tunnel: ${params.tunnelId}
credentials-file: ${params.credentialsFile}
ingress:
  - hostname: ${params.hostname}
    path: ^/hooks/.*
    service: http://127.0.0.1:${params.webhookPort}
  - hostname: ${params.hostname}
    service: http://127.0.0.1:${params.proxyPort}
  - service: http_status:404
`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf-8')
  return path
}

export interface NamedTunnelHandle {
  process: ChildProcess
  kill: () => void
  /** Register a callback fired when the cloudflared process exits; returns an unsubscriber. */
  onExit: (callback: (code: number | null) => void) => () => void
}

/** Spawn a named (locally-managed) tunnel using a config.yml written by writeNamedTunnelConfig. */
export function startNamedTunnel({ configPath, tunnelId }: { configPath: string; tunnelId: string }): NamedTunnelHandle {
  const child = spawn('cloudflared', ['tunnel', '--config', configPath, 'run', tunnelId], { stdio: ['ignore', 'pipe', 'pipe'] })
  return { process: child, kill: () => { child.kill() }, onExit: makeOnExit(child) }
}

export interface TunnelStatus {
  running: boolean
  mode?: 'quick' | 'named'
  publicUrl?: string
  /** downloading/starting/registering report live progress while the tunnel comes up. */
  phase: 'idle' | 'downloading' | 'starting' | 'registering' | 'ready' | 'error'
  errorMessage?: string
}

export interface ProxyStatus {
  running: boolean
  port?: number
  lanUrls: string[]
  errorMessage?: string
}

export interface TunnelController {
  start: () => Promise<TunnelStatus>
  stop: () => Promise<TunnelStatus>
  status: () => TunnelStatus
  proxyStatus: () => ProxyStatus
  /** Resolves after the proxy and any configured boot-time tunnel restore have settled. */
  initialReady: () => Promise<void>
  /** Re-read the user config so hostname/PIN changes apply without a restart. */
  reloadConfig: () => Promise<void>
  /** Current public PIN, generating and persisting one on first read. */
  getPin: () => Promise<string>
  /** Generate and persist a fresh public PIN, invalidating the previous one. */
  rotatePin: () => Promise<string>
  /** Current LAN PIN (separate file so rotating the public PIN cannot invalidate LAN links). */
  getLanPin: () => Promise<string>
  /** Generate and persist a fresh LAN PIN. */
  rotateLanPin: () => Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    maestroTunnel: {
      status(): any
      start(): Promise<any>
      stop(): Promise<any>
      proxyStatus(): any
      reloadConfig(): Promise<void>
      initialReady(): Promise<void>
      getPin(): Promise<string>
      rotatePin(): Promise<string>
      getLanPin(): Promise<string>
      rotateLanPin(): Promise<string>
    }
  }
}

export const name = 'maestro-tunnel'
export const inject = ['webServer']

/**
 * Test seam: lets specs stub the cloudflared resolver for tunnels started
 * through apply() — without it, a spec machine without cloudflared on PATH
 * would hit the real download chain. Undefined in production.
 */
let testResolverInternals: { commandOnPath?: () => boolean; fetch?: typeof fetch } | undefined

/** Register resolver internals used by every subsequent apply()-driven start. */
export function setResolverInternalsForTests(internals: typeof testResolverInternals): void {
  testResolverInternals = internals
}

export function apply(ctx: Context): void {
  let current: { handle: QuickTunnelHandle | NamedTunnelHandle; mode: 'quick' | 'named'; url?: string; disposeExit: () => void } | undefined
  let status: TunnelStatus = { running: false, phase: 'idle' }
  let proxy: RemoteProxyHandle | undefined
  let proxyState: ProxyStatus = { running: false, lanUrls: [] }
  // Refreshed whenever config is loaded so the PIN gate classifies hosts by
  // the hostname the tunnel actually uses.
  let configuredHostname: string | undefined
  let proxyPort = 3081
  // In-flight start (single-flight): concurrent start calls share one attempt
  // so two callers can never spawn two cloudflared processes.
  let starting: Promise<TunnelStatus> | undefined
  /** Aborts an in-flight start; stop() uses this so a half-started tunnel dies. */
  let startAbort: AbortController | undefined

  async function bootProxy(): Promise<void> {
    // Close the previous listener first: a changed LAN-PIN gate must take over
    // the same port instead of leaking the old, ungated listener beside the new one.
    await proxy?.close()
    proxy = undefined
    const bootConfig = await loadUserConfig()
    configuredHostname = bootConfig.tunnelHostname
    const requestedPort = bootConfig.proxyPort ?? 3081
    // Try the configured port first, then walk up a few ports when it is
    // busy (EADDRINUSE) — a stale process on 3081 must not kill remote access.
    let lastError: unknown
    for (let candidate = requestedPort; candidate < requestedPort + 10; candidate++) {
      try {
        const handle = await createRemoteProxy({
          port: candidate,
          host: bootConfig.proxyHost ?? '0.0.0.0',
          upstream: { host: '127.0.0.1', port: (ctx as any).webServer.port },
          auth: {
            isPublic: (host) => isPublicHost(host, configuredHostname),
            getPin: () => readPin(),
            // Opt-in: an untouched config keeps LAN access open. The login
            // page and cookie flow are shared with the public PIN gate.
            ...(bootConfig.lanPinEnabled === true ? { getLanPin: () => readLanPin() } : {}),
          },
        })
        proxy = handle
        if (candidate !== requestedPort) {
          ctx.logger?.warn?.(`maestro-tunnel: proxy port ${requestedPort} busy — listening on ${candidate} instead`)
        }
        proxyState = { running: true, port: handle.port, lanUrls: lanUrls(handle.port) }
        // Named-tunnel ingress must route public traffic at the port actually
        // bound, not the configured request that may have been walked past.
        proxyPort = handle.port
        return
      } catch (err) {
        lastError = err
        const code = (err as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'EADDRINUSE') break
      }
    }
    proxyState = { running: false, lanUrls: [], errorMessage: lastError instanceof Error ? lastError.message : String(lastError) }
  }

  const initialReady = bootProxy().then(async () => {
    await maybeAutoRestore(await loadUserConfig())
  })

  async function maybeAutoRestore(config: Awaited<ReturnType<typeof loadUserConfig>>): Promise<void> {
    if (config.lastTunnelRunning !== true) return
    const mode = config.tunnelMode ?? 'quick'
    if (mode === 'quick') {
      // Quick URLs are ephemeral — restoring one is meaningless, and keeping
      // the flag set would surprise-restore a later named configuration.
      await saveUserConfig({ lastTunnelRunning: false })
      return
    }
    if (config.tunnelId === undefined || config.tunnelCredentialsFile === undefined || config.tunnelHostname === undefined) {
      ctx.logger?.warn?.('maestro-tunnel: lastTunnelRunning is set but named config is incomplete — tunnel not restored')
      return
    }
    await start()
  }

  /** Wire process-exit tracking for a freshly started tunnel handle. */
  function watchExit(handle: QuickTunnelHandle | NamedTunnelHandle): () => void {
    const onExit = handle.onExit
    if (onExit === undefined) return () => {}
    return onExit((code) => {
      // An intentional stop() killed the child; that is not a failure.
      if (current === undefined) return
      current = undefined
      status = { running: false, phase: 'error', errorMessage: `cloudflared process exited (code=${code ?? 'signal'})` }
    })
  }

  async function start(): Promise<TunnelStatus> {
    if (current !== undefined) return status
    if (starting !== undefined) return starting
    const abort = new AbortController()
    startAbort = abort
    const attempt: Promise<TunnelStatus> = (async () => {
      const userConfig = await loadUserConfig()
      configuredHostname = userConfig.tunnelHostname
      const mode = userConfig.tunnelMode ?? 'quick'
      status = { running: false, mode, phase: 'starting' }
      try {
        if (mode === 'quick') {
          const target = userConfig.quickTarget === 'webhook' ? (userConfig.webhookPort ?? 3000) : (ctx as any).webServer.port
          const handle = await startQuickTunnel({
            port: target,
            home: process.env.DSH_HOME,
            signal: abort.signal,
            onPhase: (phase) => { status = { ...status, phase } },
            // The plugin process itself is the "PATH" for tests; production
            // resolves through the real PATH check inside resolveCloudflared.
            ...(testResolverInternals !== undefined ? { internals: testResolverInternals } : {}),
          })
          current = { handle, mode: 'quick', url: handle.url, disposeExit: watchExit(handle) }
          status = { running: true, mode: 'quick', publicUrl: handle.url, phase: 'ready' }
        } else {
          if (userConfig.tunnelId === undefined || userConfig.tunnelCredentialsFile === undefined || userConfig.tunnelHostname === undefined) {
            throw new Error('Named tunnel requires tunnelId, tunnelCredentialsFile and tunnelHostname — run `cloudflared tunnel login` then `cloudflared tunnel create <name>` once, then save those values.')
          }
          const dshHome = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`
          const configPath = await writeNamedTunnelConfig({
            dshHome,
            tunnelId: userConfig.tunnelId,
            credentialsFile: userConfig.tunnelCredentialsFile,
            hostname: userConfig.tunnelHostname,
            webhookPort: userConfig.webhookPort ?? 3000,
            proxyPort,
          })
          const handle = startNamedTunnel({ configPath, tunnelId: userConfig.tunnelId })
          current = { handle, mode: 'named', url: `https://${userConfig.tunnelHostname}`, disposeExit: watchExit(handle) }
          status = { running: true, mode: 'named', publicUrl: current.url, phase: 'ready' }
        }
        await saveUserConfig({ lastTunnelRunning: true })
      } catch (err) {
        if (!abort.signal.aborted) {
          status = { running: false, mode, phase: 'error', errorMessage: err instanceof Error ? err.message : String(err) }
        }
      } finally {
        // Only clear our own in-flight record: a stop-then-start sequence may
        // already have installed a newer attempt.
        if (startAbort === abort) startAbort = undefined
      }
      if (startAbort === abort) startAbort = undefined
      return status
    })()
    starting = attempt
    return starting
  }

  async function stop(): Promise<TunnelStatus> {
    startAbort?.abort()
    startAbort = undefined
    starting = undefined
    if (current !== undefined) {
      current.disposeExit()
      current.handle.kill()
      current = undefined
    }
    status = { running: false, phase: 'idle' }
    await saveUserConfig({ lastTunnelRunning: false })
    return status
  }

  ctx.effect(() => async () => {
    startAbort?.abort()
    starting = undefined
    // Teardown stops the cloudflared child but deliberately keeps
    // lastTunnelRunning: the child dies with this process anyway, and the next
    // boot should restore what the user left running. Only an explicit user
    // stop clears the flag.
    if (current !== undefined) {
      current.disposeExit()
      current.handle.kill()
      current = undefined
    }
    status = { running: false, phase: 'idle' }
    await proxy?.close()
  }, 'maestro-tunnel teardown')

  const tunnelController: TunnelController = {
    start,
    stop,
    status: () => status,
    proxyStatus: () => proxyState,
    initialReady: () => initialReady,
    reloadConfig: () => bootProxy().then(() => {}),
    getPin: () => readPin(),
    rotatePin: () => rotatePin(),
    getLanPin: () => readLanPin(),
    rotateLanPin: () => rotateLanPin(),
  }
  ctx.provide('maestroTunnel', tunnelController)
  // The tunnel owns the startup boundary: once the controller is ready (and only if the
  // optional notifier plugin is installed), deliver the protected "DSH web is ready" update.
  scheduleStartupNotification({
    initialReady: () => tunnelController.initialReady(),
    loadConfig: () => loadUserConfig(),
    readPin,
    readToken: async () => {
      try {
        const conn = (ctx as any).connection as { authenticatedUrl?: (url: string) => string } | undefined
        if (conn?.authenticatedUrl === undefined) return undefined
        const url = conn.authenticatedUrl('http://127.0.0.1:3080')
        return new URL(url).searchParams.get('token') ?? undefined
      } catch {
        return undefined
      }
    },
    proxyStatus: () => tunnelController.proxyStatus(),
    status: () => tunnelController.status(),
    notifier: () => ctx.get?.('maestroNotifier') as import('./startup-notify.js').NotifierLike | undefined,
    logger: ctx.logger,
  })
}
