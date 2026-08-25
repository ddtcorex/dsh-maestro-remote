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
  proxyStatus: () => { running: boolean; lanUrls: string[]; errorMessage?: string }
  status: () => { running: boolean; publicUrl?: string; errorMessage?: string }
  /** Optional notifier service; when absent the startup update is skipped entirely. */
  notifier?: NotifierLike
  logger?: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void }
}

function startupText({ pin, proxy, tunnel }: {
  pin: string
  proxy: { running: boolean; lanUrls: string[]; errorMessage?: string }
  tunnel: { running: boolean; publicUrl?: string; errorMessage?: string }
}): string {
  const lines = ['DSH web is ready', `Public access PIN: ${pin}`]
  if (tunnel.running && tunnel.publicUrl !== undefined) lines.push(`Public URL: ${tunnel.publicUrl}`)
  else if (tunnel.errorMessage !== undefined) lines.push(`Tunnel: ${tunnel.errorMessage}`)
  else lines.push('Tunnel: not running')
  if (proxy.running && proxy.lanUrls.length > 0) lines.push(`LAN: ${proxy.lanUrls.join(', ')}`)
  else if (proxy.errorMessage !== undefined) lines.push(`Proxy: ${proxy.errorMessage}`)
  else lines.push('Proxy: not running')
  return lines.join('\n')
}

/** Send one optional, protected startup update after the tunnel reaches its ready boundary. Never throws. */
export function scheduleStartupNotification(dependencies: StartupNotifyDependencies): void {
  void dependencies.initialReady().then(async () => {
    const notifier = dependencies.notifier
    if (notifier === undefined) return
    const config = await dependencies.loadConfig()
    const delivery = await notifier.send(
      'telegram',
      { botToken: config.telegramBotToken, chatId: config.telegramChatId },
      {
        text: startupText({
          pin: await dependencies.readPin(),
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
