import { describe, expect, it, vi } from 'vitest'
import { scheduleStartupNotification, type StartupNotifyDependencies } from '../src/startup-notify.ts'

function makeDeps(overrides: Partial<StartupNotifyDependencies> = {}): StartupNotifyDependencies {
  return {
    initialReady: vi.fn().mockResolvedValue(undefined),
    loadConfig: vi.fn().mockResolvedValue({ telegramBotToken: 'bot-token', telegramChatId: '-1001234567890' }),
    readPin: vi.fn().mockResolvedValue('81117443'),
    proxyStatus: () => ({ running: true, port: 3081, lanUrls: ['http://192.168.1.20:3081'] }),
    status: () => ({ running: true, publicUrl: 'https://dsh.example.com', phase: 'ready' }),
    notifier: { send: vi.fn().mockResolvedValue({ sent: true }) },
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  }
}

const EXPECTED_TEXT = 'DSH web is ready\nPublic access PIN: 81117443\nPublic URL: https://dsh.example.com\nLAN: http://192.168.1.20:3081'

describe('scheduleStartupNotification', () => {
  it('waits for initialReady, then sends the telegram target and startup text without leaking credentials to logs', async () => {
    let releaseInitialReady: (() => void) | undefined
    const deps = makeDeps({
      initialReady: vi.fn().mockImplementation(() => new Promise<void>((resolve) => { releaseInitialReady = resolve })),
    })

    scheduleStartupNotification(deps)
    expect(deps.notifier!.send).not.toHaveBeenCalled()

    releaseInitialReady!()
    await vi.waitFor(() => expect(deps.notifier!.send).toHaveBeenCalledWith(
      'telegram',
      { botToken: 'bot-token', chatId: '-1001234567890' },
      { text: EXPECTED_TEXT },
    ))
    expect(deps.logger?.info).toHaveBeenCalledWith('maestro-telegram: startup notification delivered')
    expect(JSON.stringify([deps.logger?.info, deps.logger?.warn])).not.toMatch(/bot-token|-1001234567890|81117443/)
  })

  it('logs a sanitized warning on request-failed delivery', async () => {
    const deps = makeDeps({ notifier: { send: vi.fn().mockResolvedValue({ sent: false, reason: 'request-failed' }) } })
    scheduleStartupNotification(deps)
    await vi.waitFor(() => expect(deps.logger?.warn).toHaveBeenCalledWith('maestro-telegram: startup notification failed'))
    expect(deps.logger?.info).not.toHaveBeenCalled()
  })

  it('stays silent on a not-configured delivery result', async () => {
    const deps = makeDeps({ notifier: { send: vi.fn().mockResolvedValue({ sent: false, reason: 'not-configured' }) } })
    scheduleStartupNotification(deps)
    await vi.waitFor(() => expect(deps.notifier!.send).toHaveBeenCalled())
    expect(deps.logger?.info).not.toHaveBeenCalled()
    expect(deps.logger?.warn).not.toHaveBeenCalled()
  })

  it('never throws when initialReady rejects', async () => {
    const deps = makeDeps({ initialReady: vi.fn().mockRejectedValue(new Error('boom')) })
    expect(() => scheduleStartupNotification(deps)).not.toThrow()
    await vi.waitFor(() => expect(deps.logger?.warn).toHaveBeenCalledWith('maestro-telegram: startup notification failed'))
  })

  it('no-ops when the optional notifier service is absent', async () => {
    const deps = makeDeps({ notifier: undefined })
    expect(() => scheduleStartupNotification(deps)).not.toThrow()
    await deps.initialReady()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deps.loadConfig).not.toHaveBeenCalled()
  })
})
