import type { Context } from '@deepseek-ai/cordis'
import { loadUserConfig } from './config-store.js'
import { readPin } from './pin-store.js'
import { sendTelegramStartupNotification } from './telegram-notifier.js'

export const name = 'maestro-telegram'
export const inject = ['maestroTunnel']

/** Send one optional, protected startup update without making Telegram availability a DSH dependency. */
export function apply(ctx: Context): void {
  void ctx.maestroTunnel.initialReady().then(async () => {
    const config = await loadUserConfig()
    const delivery = await sendTelegramStartupNotification({
      botToken: config.telegramBotToken,
      chatId: config.telegramChatId,
      pin: await readPin(),
      proxy: ctx.maestroTunnel.proxyStatus(),
      tunnel: ctx.maestroTunnel.status(),
    })
    if (delivery.sent) {
      ctx.logger?.info?.('maestro-telegram: startup notification delivered')
    } else if (delivery.reason === 'request-failed') {
      ctx.logger?.warn?.('maestro-telegram: startup notification failed')
    }
  }).catch(() => {
    ctx.logger?.warn?.('maestro-telegram: startup notification failed')
  })
}
