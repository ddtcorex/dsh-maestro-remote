import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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

export function configStorePath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'dsh-maestro-remote', 'config.json')
}

function legacyConfigStorePath(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'dsh-maestro-harness', 'config.json')
}

async function maybeMigrateLegacyConfig(dshHome?: string): Promise<void> {
  const newPath = configStorePath(dshHome)
  const legacyPath = legacyConfigStorePath(dshHome)
  try {
    await readFile(newPath, 'utf-8')
    return
  } catch {}
  try {
    const data = await readFile(legacyPath, 'utf-8')
    await mkdir(dirname(newPath), { recursive: true, mode: 0o700 })
    await writeFile(newPath, data, { encoding: 'utf-8', mode: 0o600 })
    await chmod(newPath, 0o600)
  } catch {}
}

export async function loadUserConfig(dshHome?: string): Promise<MaestroUserConfig> {
  await maybeMigrateLegacyConfig(dshHome)
  try {
    return JSON.parse(await readFile(configStorePath(dshHome), 'utf-8'))
  } catch {
    return {}
  }
}

export async function saveUserConfig(patch: MaestroUserConfig, dshHome?: string): Promise<MaestroUserConfig> {
  const current = await loadUserConfig(dshHome)
  const merged = { ...current, ...patch }
  const path = configStorePath(dshHome)
  // `MaestroUserConfig` carries real secrets (gitlabToken, webhookSecret) — write the
  // directory and file owner-only so another local user on a shared host can't read
  // them off disk. `writeFile`'s `mode` only applies when it creates the file, so the
  // trailing `chmod` is defense-in-depth for the case where the file already existed
  // (e.g. written by an earlier version of this store without this fix).
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 })
  await chmod(path, 0o600)
  return merged
}
