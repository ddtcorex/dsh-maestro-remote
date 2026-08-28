/** Provider-neutral notifier contract slice plus the startup message this plugin owns. */

export interface NotifyDeliveryResult {
  sent: boolean
  reason?: 'not-configured' | 'request-failed' | 'unknown-provider'
}

/**
 * Structural view of the optional `maestroNotifier` service published by
 * `@ddtcorex/dsh-maestro-notifier`. Consumed via `ctx.get` so an absent
 * notifier plugin degrades to "no notifications" instead of blocking startup.
 */
export interface NotifierLike {
  send(providerId: string, target: Record<string, unknown>, message: { text: string }): Promise<NotifyDeliveryResult>
}

export interface StartupNotifyDependencies {
  initialReady: () => Promise<void>
  loadConfig: () => Promise<{ telegramBotToken?: string; telegramChatId?: string }>
  readPin: () => Promise<string>
  readToken?: () => Promise<string | undefined>
  proxyStatus: () => { running: boolean; lanUrls: string[]; errorMessage?: string }
  status: () => { running: boolean; publicUrl?: string; errorMessage?: string }
  /** Optional notifier service; when absent the startup update is skipped entirely. May be a lazy provider to handle service registration order. */
  notifier?: NotifierLike | (() => NotifierLike | undefined)
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function startupText({ pin, proxy, tunnel }: {
  pin: string
  proxy: { running: boolean; lanUrls: string[]; errorMessage?: string }
  tunnel: { running: boolean; publicUrl?: string; errorMessage?: string }
}): string {
  const pinEsc = escapeHtml(pin)
  const lines: string[] = []
  lines.push('<b>🚀 DSH Web is Ready</b>')
  lines.push('')
  lines.push(`<b>🔑 PIN:</b> <code>${pinEsc}</code>`)
  lines.push('')
  if (tunnel.running && tunnel.publicUrl !== undefined) {
    const urlEsc = escapeHtml(tunnel.publicUrl)
    lines.push(`<b>🌐 Public URL:</b> ${urlEsc}`)
  } else if (tunnel.errorMessage !== undefined) lines.push(`<b>⚠️ Tunnel:</b> ${escapeHtml(tunnel.errorMessage)}`)
  else lines.push('<b>⚠️ Tunnel:</b> not running')
  lines.push('')
  if (proxy.running && proxy.lanUrls.length > 0) {
    const lanEsc = proxy.lanUrls.map(l => escapeHtml(l)).join(', ')
    lines.push(`<b>🏠 LAN:</b> ${lanEsc}`)
  } else if (proxy.errorMessage !== undefined) lines.push(`<b>⚠️ Proxy:</b> ${escapeHtml(proxy.errorMessage)}`)
  else lines.push('<b>⚠️ Proxy:</b> not running')
  return lines.join('\n')
}

/** Send one optional, protected startup update after the tunnel reaches its ready boundary. Never throws. */
export function scheduleStartupNotification(dependencies: StartupNotifyDependencies): void {
  void dependencies.initialReady().then(async () => {
    const raw = dependencies.notifier
    const notifier = typeof raw === 'function' ? (raw as () => NotifierLike | undefined)() : raw
    if (notifier === undefined) return
    const config = await dependencies.loadConfig()
    const pin = await dependencies.readPin()
    const delivery = await notifier.send(
      'telegram',
      { botToken: config.telegramBotToken, chatId: config.telegramChatId },
      {
        text: startupText({
          pin,
          proxy: dependencies.proxyStatus(),
          tunnel: dependencies.status(),
        }),
      },
    )
    if (delivery.sent) {
      dependencies.logger?.info?.('maestro-telegram: startup notification delivered')
    } else if (delivery.reason === 'request-failed') {
      dependencies.logger?.warn?.('maestro-telegram: startup notification failed')
    }
  }).catch(() => {
    dependencies.logger?.warn?.('maestro-telegram: startup notification failed')
  })
}
