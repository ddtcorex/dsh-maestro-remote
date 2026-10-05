/**
 * Loopback RPC for the tunnel, proxy and PIN, on this package's own channel.
 *
 * All nine of these used to be served by `dsh-maestro-review` on
 * `/dsh-maestro-review`, where each one delegated straight back to the
 * `maestroTunnel` service this package provides. Endpoint strings did not
 * change, only the channel that carries them, so a client that already knows
 * `maestro.rotatePin` needs no change beyond its channel.
 *
 * Every answer uses the `RpcResult` envelope. A bare `{ ok: true }` is not a
 * usable success: clients read `res.value`, so it answers every field with
 * `undefined` and renders an empty form that saves nothing.
 */
import { load, set } from './vendor/store.js'
import { pinRotationText } from './startup-notify.js'
import { MAX_PIN_SESSION_TTL_HOURS } from './remote-proxy.js'

/** Single segment, per the harness channel contract. */
export const RPC_CHANNEL = '/dsh-maestro-remote'

type Ok<T> = { ok: true; value: T }
type Failure = { ok: false; error: string }

const ok = <T>(value: T): Ok<T> => ({ ok: true, value })
const fail = (error: string): Failure => ({ ok: false, error })

/** The slice of `maestroTunnel` these endpoints use, so a test can pass a double. */
export interface TunnelLike {
  status(): unknown
  start(): Promise<unknown>
  stop(): Promise<unknown>
  proxyStatus(): unknown
  reloadConfig(): Promise<void>
  getPin(): Promise<string>
  rotatePin(): Promise<string>
  getLanPin(): Promise<string>
  rotateLanPin(): Promise<string>
}

export interface NotifierLike {
  send(provider: string, target: unknown, payload: { text: string }): Promise<{ sent: boolean; reason?: string }>
}

export interface RpcDeps {
  tunnel: TunnelLike
  /** Optional: notifications are best effort and never gate the answer. */
  notifier?: NotifierLike | undefined
  logger?: { info?: (m: string) => void; warn?: (m: string) => void } | undefined
}

/**
 * The nine tunnel, proxy and PIN keys remote owns, and nothing else.
 *
 * Every one of them lives in the SAME `tunnel` domain, so the set is a
 * whitelist of key names rather than a flat-to-dotted map. Review's version
 * needed the dotted map because it wrote three domains at once; writing
 * `domains.tunnel.tunnel.*` is what mapping them here would produce.
 */
const SAVABLE = new Set([
  'tunnelMode', 'quickTarget', 'tunnelId', 'tunnelCredentialsFile', 'tunnelHostname',
  'proxyPort', 'proxyHost', 'lanPinEnabled', 'pinSessionTtlHours',
])

/**
 * `lanPort` and `lanHost` are deliberately absent. They exist in the store's
 * key map but are machine-local: a harness sync rewrites `domains.tunnel` from
 * the per-machine tunnel profile, so a Settings write for either is discarded
 * without a word. Making them savable looks like a fix and reopens the
 * 2026-09-02 outage.
 */
function validatePinTtl(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'pinSessionTtlHours must be an integer.'
  if (value < 0 || value > MAX_PIN_SESSION_TTL_HOURS) {
    return `pinSessionTtlHours must be between 0 and ${MAX_PIN_SESSION_TTL_HOURS}.`
  }
  return null
}

async function saveTunnelConfig(payload: unknown): Promise<Ok<unknown> | Failure> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return fail('Settings payload must be a JSON object.')
  }
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!SAVABLE.has(key)) return fail(`Unknown settings key "${key}".`)
    if (key === 'pinSessionTtlHours' && value !== undefined) {
      const problem = validatePinTtl(value)
      if (problem !== null) return fail(problem)
    }
    if (key === 'proxyPort' && value !== undefined && value !== null) {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('proxyPort must be an integer between 1 and 65535.')
    }
    patch[key] = value
  }
  await set('tunnel', patch)
  return ok((await load()).domains.tunnel)
}

export function createRpcHandler(deps: RpcDeps): (endpoint: string, payload: unknown) => Promise<Ok<unknown> | Failure> {
  const { tunnel, notifier, logger } = deps
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case 'maestro.status':
          return ok(tunnel.status())
        case 'maestro.tunnelStart':
          return ok(await tunnel.start())
        case 'maestro.tunnelStop':
          return ok(await tunnel.stop())
        case 'maestro.proxyStatus':
          return ok(tunnel.proxyStatus())
        case 'maestro.getPin':
          return ok({ pin: await tunnel.getPin() })
        case 'maestro.rotatePin': {
          const pin = await tunnel.rotatePin()
          // Delivery is deliberately detached: a slow or unavailable
          // notifier cannot make an explicit security operation appear to
          // fail or hold the Settings UI open.
          void Promise.resolve()
            .then(async () => {
              if (notifier === undefined) return undefined
              const doc = await load()
              const telegram = (doc.domains.notifier as { telegram?: { botToken?: string; chatId?: string } } | undefined)?.telegram
              if (!telegram?.botToken || !telegram.chatId) return undefined
              return notifier.send('telegram', { botToken: telegram.botToken, chatId: telegram.chatId }, { text: pinRotationText(pin) })
            })
            .then((delivery) => {
              if (!delivery) return
              if (delivery.sent) logger?.info?.('maestro-telegram: PIN rotation notification delivered')
              else if (delivery.reason === 'request-failed') logger?.warn?.('maestro-telegram: PIN rotation notification failed')
            })
            .catch(() => logger?.warn?.('maestro-telegram: PIN rotation notification failed'))
          return ok({ pin })
        }
        case 'maestro.lanPin.status': {
          const doc = await load()
          const tunnelDomain = doc.domains.tunnel as { lanPinEnabled?: unknown } | undefined
          // Disabled by default; the LAN PIN is only read (and generated) once
          // the user opts in, so an untouched install keeps LAN access open.
          if (tunnelDomain?.lanPinEnabled !== true) return ok({ enabled: false })
          return ok({ enabled: true, pin: await tunnel.getLanPin() })
        }
        case 'maestro.lanPin.setEnabled': {
          const enabled = (payload as { enabled?: unknown } | undefined)?.enabled === true
          await set('tunnel', { lanPinEnabled: enabled })
          // The proxy reads lanPinEnabled at boot; a reload applies the new
          // gate without waiting for a harness restart.
          await tunnel.reloadConfig()
          // The gate lives in the proxy listener, not in the settings store, so
          // a client cannot infer "live" from a successful write. Say so
          // explicitly instead of letting the card imply the gate is in force.
          return ok({ enabled, requiresRestart: true })
        }
        case 'maestro.lanPin.rotate':
          return ok({ pin: await tunnel.rotateLanPin() })
        case 'maestro.saveConfig':
          return await saveTunnelConfig(payload)
        case 'maestro.getConfig':
          // The tunnel domain, and nothing else. Another plugin's keys are not
          // readable through this channel even though they share the file.
          return ok((await load()).domains.tunnel ?? {})
        default:
          return fail(`unknown endpoint: ${String(endpoint)}`)
      }
    } catch (e: unknown) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }
}