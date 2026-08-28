import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Constant-time comparison of two secrets through sha256 digests, so differing
 * lengths leak nothing and `timingSafeEqual`'s equal-length requirement is
 * always met. Fails closed when either side is missing.
 */
export function secretsMatch(provided: string | string[] | undefined, expected: string | undefined): boolean {
  if (provided === undefined || expected === undefined || expected === '') return false
  const providedDigest = createHash('sha256').update(Array.isArray(provided) ? provided[0] ?? '' : provided).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}
