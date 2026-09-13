/**
 * Run async writes one after another in call order.
 *
 * `start()` and `stop()` both persist `lastTunnelRunning`, and either can run
 * while the other is still in flight. Without serialization the two writes can
 * interleave and a slow one lands last, resurrecting a marker the user just
 * cleared (spec D9). The returned function never overlaps writes, preserves
 * call order, and still hands each caller the rejection of its own write.
 */
export function createSerializedWriter<T>(write: (value: T) => Promise<void>): (value: T) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (value: T): Promise<void> => {
    const run = tail.then(() => write(value))
    // Keep the chain alive after a failed write, but let the caller see it.
    tail = run.catch(() => {})
    return run
  }
}
