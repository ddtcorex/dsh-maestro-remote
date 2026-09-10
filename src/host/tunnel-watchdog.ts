/**
 * Retry policy for the maestro tunnel child process.
 *
 * The tunnel controller restores the user's tunnel once at boot
 * (`maybeAutoRestore`). Without a watchdog, a child that dies afterwards —
 * or a boot-time start that fails transiently (network not ready yet) —
 * leaves the tunnel down until someone restarts `dsh web` by hand. The
 * watchdog keeps retrying with backoff for as long as the user's intent
 * (`lastTunnelRunning`) is still set; an explicit stop cancels it.
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  5_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
]

export interface TunnelWatchdogOptions {
  /** Attempt a (re)start; the watchdog never inspects the result. */
  onRetry: () => void
  /** Per-failure delays; the last entry repeats once exhausted. */
  delaysMs?: readonly number[]
}

export interface TunnelWatchdog {
  /** Record a failure and schedule a retry (no-op after cancel/dispose). */
  notifyDown: () => void
  /** Record a success: reset the backoff and drop any pending retry. */
  notifyUp: () => void
  /** Explicit user stop: drop any pending retry and reset the backoff. */
  cancel: () => void
  /** Permanent teardown: drop timers and ignore every later signal. */
  dispose: () => void
  readonly pending: boolean
  readonly consecutiveFailures: number
}

export function createTunnelWatchdog(options: TunnelWatchdogOptions): TunnelWatchdog {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function clearPending(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  return {
    notifyDown() {
      if (disposed || timer !== undefined) return
      const delay = delays[Math.min(failures, delays.length - 1)] ?? 0
      failures += 1
      timer = setTimeout(() => {
        timer = undefined
        if (disposed) return
        options.onRetry()
      }, delay)
    },
    notifyUp() {
      failures = 0
      clearPending()
    },
    cancel() {
      failures = 0
      clearPending()
    },
    dispose() {
      disposed = true
      clearPending()
    },
    get pending() {
      return timer !== undefined
    },
    get consecutiveFailures() {
      return failures
    },
  }
}
