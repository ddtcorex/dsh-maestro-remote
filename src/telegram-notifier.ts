export interface TelegramStartupNotification {
  botToken?: string
  chatId?: string
  pin: string
  proxy: { running: boolean; port?: number; lanUrls: string[]; errorMessage?: string }
  tunnel: { running: boolean; publicUrl?: string; errorMessage?: string }
}

export interface TelegramNotifierDependencies {
  fetch?: typeof globalThis.fetch
}

export type TelegramDeliveryResult =
  | { sent: true }
  | { sent: false; reason: 'not-configured' | 'request-failed' }

interface TelegramRecipient {
  botToken?: string
  chatId?: string
}

function startupText({ pin, proxy, tunnel }: TelegramStartupNotification): string {
  const lines = ['DSH web is ready', `Public access PIN: ${pin}`]
  if (tunnel.running && tunnel.publicUrl !== undefined) lines.push(`Public URL: ${tunnel.publicUrl}`)
  else if (tunnel.errorMessage !== undefined) lines.push(`Tunnel: ${tunnel.errorMessage}`)
  else lines.push('Tunnel: not running')
  if (proxy.running && proxy.lanUrls.length > 0) lines.push(`LAN: ${proxy.lanUrls.join(', ')}`)
  else if (proxy.errorMessage !== undefined) lines.push(`Proxy: ${proxy.errorMessage}`)
  else lines.push('Proxy: not running')
  return lines.join('\n')
}

async function sendTelegramText(
  { botToken, chatId }: TelegramRecipient,
  text: string,
  { fetch: fetchImpl = globalThis.fetch }: TelegramNotifierDependencies,
): Promise<TelegramDeliveryResult> {
  if (botToken?.trim() === '' || botToken === undefined || chatId?.trim() === '' || chatId === undefined) {
    return { sent: false, reason: 'not-configured' }
  }
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        protect_content: true,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    return response.ok ? { sent: true } : { sent: false, reason: 'request-failed' }
  } catch {
    return { sent: false, reason: 'request-failed' }
  }
}

/** Send the one-shot DSH boot notification. Never throws so an optional notifier cannot block DSH startup. */
export async function sendTelegramStartupNotification(
  notification: TelegramStartupNotification,
  dependencies: TelegramNotifierDependencies = {},
): Promise<TelegramDeliveryResult> {
  return sendTelegramText(notification, startupText(notification), dependencies)
}

/** Notify the configured chat about an explicit public-PIN rotation. Never throws. */
export async function sendTelegramPinRotationNotification(
  notification: TelegramRecipient & { pin: string },
  dependencies: TelegramNotifierDependencies = {},
): Promise<TelegramDeliveryResult> {
  return sendTelegramText(notification, `DSH public access PIN was rotated\nNew PIN: ${notification.pin}`, dependencies)
}

export interface TelegramReviewNotification extends TelegramRecipient {
  projectPath: string
  mrIid: number
  status: 'completed' | 'failed'
  summary?: string
}

/** One-line digest after a review run. Never throws. */
export async function sendTelegramReviewNotification(
  notification: TelegramReviewNotification,
  dependencies: TelegramNotifierDependencies = {},
): Promise<TelegramDeliveryResult> {
  const outcome = notification.status === 'completed' ? '✅ completed' : '⚠️ failed'
  const summary = notification.summary === undefined ? '' : `\n${notification.summary}`
  return sendTelegramText(
    notification,
    `Maestro review of ${notification.projectPath} !${notification.mrIid}: ${outcome}${summary}`,
    dependencies,
  )
}
