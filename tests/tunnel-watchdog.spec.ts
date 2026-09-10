import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTunnelWatchdog, DEFAULT_RETRY_DELAYS_MS } from '../src/host/tunnel-watchdog.ts';

describe('tunnel watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries once after the first failure delay', () => {
    const onRetry = vi.fn();
    const watchdog = createTunnelWatchdog({ onRetry });

    watchdog.notifyDown();

    expect(watchdog.pending).toBe(true);
    expect(onRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEFAULT_RETRY_DELAYS_MS[0] - 1);
    expect(onRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(watchdog.pending).toBe(false);
  });

  it('backs off across consecutive failures', () => {
    const onRetry = vi.fn();
    const watchdog = createTunnelWatchdog({ onRetry });

    watchdog.notifyDown();
    vi.advanceTimersByTime(DEFAULT_RETRY_DELAYS_MS[0]);
    expect(onRetry).toHaveBeenCalledTimes(1);

    watchdog.notifyDown();
    vi.advanceTimersByTime(DEFAULT_RETRY_DELAYS_MS[1] - 1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(watchdog.consecutiveFailures).toBe(2);
  });

  it('resets the backoff after a success', () => {
    const onRetry = vi.fn();
    const watchdog = createTunnelWatchdog({ onRetry });

    watchdog.notifyDown();
    vi.advanceTimersByTime(DEFAULT_RETRY_DELAYS_MS[0]);
    watchdog.notifyUp();

    watchdog.notifyDown();
    vi.advanceTimersByTime(DEFAULT_RETRY_DELAYS_MS[0]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(watchdog.consecutiveFailures).toBe(1);
  });

  it('does not retry after an explicit cancel', () => {
    const onRetry = vi.fn();
    const watchdog = createTunnelWatchdog({ onRetry });

    watchdog.notifyDown();
    watchdog.cancel();

    expect(watchdog.pending).toBe(false);
    vi.advanceTimersByTime(DEFAULT_RETRY_DELAYS_MS.at(-1) ?? 0);
    expect(onRetry).not.toHaveBeenCalled();

    // A later failure starts over from the first delay.
    watchdog.notifyDown();
    vi.advanceTimersByTime(DEFAULT_RETRY_DELAYS_MS[0]);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('never fires again after dispose', () => {
    const onRetry = vi.fn();
    const watchdog = createTunnelWatchdog({ onRetry });

    watchdog.notifyDown();
    watchdog.dispose();

    vi.advanceTimersByTime(DEFAULT_RETRY_DELAYS_MS.at(-1) ?? 0);
    expect(onRetry).not.toHaveBeenCalled();

    watchdog.notifyDown();
    vi.advanceTimersByTime(DEFAULT_RETRY_DELAYS_MS.at(-1) ?? 0);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
