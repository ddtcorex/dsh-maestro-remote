import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  RUNTIME_KEYS,
  readFlat,
  writeLegacyPatch,
} from '@ddtcorex/dsh-maestro-config-lib'

export type ReviewSkillProfile = 'magento2' | 'generic' | 'laravel' | 'custom'

export interface ReviewModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface MaestroUserConfig {
  gitlabBaseUrl?: string
  gitlabToken?: string
  botUsername?: string
  webhookSecret?: string
  webhookPort?: number
  projectMappings?: Array<{ projectPath: string; localRepoPath: string; reviewProfile?: ReviewSkillProfile; reviewModel?: ReviewModelSelection }>
  /** Override the DSH default model for automated reviews. When absent the global DSH default is used. */
  reviewModel?: ReviewModelSelection
  /** Re-run a quick review whenever new commits land on a previously reviewed MR. */
  autoRereviewOnPush?: boolean
  /** Bound one automated review agent's turn. */
  agentTimeoutMs?: number
  /** Prune Maestro's own review records older than this many days (0 = keep forever). */
  reviewSessionRetentionDays?: number
  tunnelMode?: 'quick' | 'named'
  quickTarget?: 'dsh-web' | 'webhook'
  tunnelId?: string
  tunnelCredentialsFile?: string
  tunnelHostname?: string
  proxyPort?: number
  proxyHost?: string
  lastTunnelRunning?: boolean
  /** Gate LAN access behind a second PIN. Default false — LAN stays open. */
  lanPinEnabled?: boolean
  /** Telegram Bot API credentials for one-way notifications. */
  telegramBotToken?: string
  telegramChatId?: string
  /** Also notify this chat when a review finishes. Default false. */
  telegramReviewNotifications?: boolean
}

function resolveDshHome(dshHome?: string): string {
  return dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Settings live in the SHARED namespaced store (`~/.dsh/maestro/settings.json`,
 * owned by @ddtcorex/dsh-maestro-config-lib); this store is a thin adapter that
 * keeps the package's flat `MaestroUserConfig` API while delegating persistence.
 * Machine runtime state (RUNTIME_KEYS) never enters settings — it stays in this
 * package's own sidecar so a settings edit can never silently flip tunnel state.
 */
export function configStorePath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'maestro', 'settings.json')
}

function runtimeStatePath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'dsh-maestro-remote', 'runtime.json')
}

async function readRuntimeState(dshHome?: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(runtimeStatePath(dshHome), 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function mergeRuntimeState(
  patch: Record<string, unknown>,
  dshHome?: string,
): Promise<void> {
  const path = runtimeStatePath(dshHome)
  const merged = { ...(await readRuntimeState(dshHome)), ...patch }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 })
  await chmod(path, 0o600)
}

export async function loadUserConfig(dshHome?: string): Promise<MaestroUserConfig> {
  const [flat, runtime] = await Promise.all([
    readFlat({ dshHome }),
    readRuntimeState(dshHome),
  ])
  return { ...flat, ...runtime } as MaestroUserConfig
}

export async function saveUserConfig(patch: MaestroUserConfig, dshHome?: string): Promise<MaestroUserConfig> {
  const settingsPatch: Record<string, unknown> = {}
  const runtimePatch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if ((RUNTIME_KEYS as readonly string[]).includes(key)) runtimePatch[key] = value
    else settingsPatch[key] = value
  }
  if (Object.keys(settingsPatch).length > 0) {
    await writeLegacyPatch(settingsPatch, { dshHome })
  }
  if (Object.keys(runtimePatch).length > 0) {
    await mergeRuntimeState(runtimePatch, dshHome)
  }
  return loadUserConfig(dshHome)
}
