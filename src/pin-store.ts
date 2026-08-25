import { randomInt } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PIN_RE = /^\d{8}$/

export function pinPath(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-maestro-remote', 'token')
}

/** LAN PIN lives in its own file so rotating the public PIN cannot invalidate LAN links. */
export function lanPinPath(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-maestro-remote', 'token-lan')
}

// Legacy paths for one-time migration from monolith `dsh-maestro-harness`.
function legacyPinPath(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-maestro-harness', 'token')
}
function legacyLanPinPath(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-maestro-harness', 'token-lan')
}

/**
 * If the new namespaced file does not exist but the legacy monolith file does,
 * copy it to the new location. This migrates users who `dsh plugin remove
 * dsh-maestro-harness && dsh plugin add dsh-maestro-remote` without losing PINs.
 */
async function maybeMigrateLegacyPin(newPath: string, legacyPath: string): Promise<void> {
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

/** Cryptographically random 8-digit PIN (Math.random is not a CSPRNG and the PIN gates public access). */
function newPin(): string {
  return String(randomInt(10_000_000, 100_000_000))
}

async function writePinFile(pin: string, path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, pin, { encoding: 'utf-8', mode: 0o600 })
  await chmod(path, 0o600)
  return pin
}

/** Current PIN, generating and persisting one when absent or malformed. */
export async function readPin(dshHome?: string): Promise<string> {
  await maybeMigrateLegacyPin(pinPath(dshHome), legacyPinPath(dshHome))
  try {
    const existing = (await readFile(pinPath(dshHome), 'utf-8')).trim()
    if (PIN_RE.test(existing)) return existing
  } catch { /* absent or unreadable — generate below */ }
  return writePinFile(newPin(), pinPath(dshHome))
}

export async function writePin(pin: string, dshHome?: string): Promise<string> {
  return writePinFile(pin, pinPath(dshHome))
}

export async function rotatePin(dshHome?: string): Promise<string> {
  return writePinFile(newPin(), pinPath(dshHome))
}

/** Current LAN PIN, generating and persisting one when absent or malformed. */
export async function readLanPin(dshHome?: string): Promise<string> {
  await maybeMigrateLegacyPin(lanPinPath(dshHome), legacyLanPinPath(dshHome))
  try {
    const existing = (await readFile(lanPinPath(dshHome), 'utf-8')).trim()
    if (PIN_RE.test(existing)) return existing
  } catch { /* absent or unreadable — generate below */ }
  return writePinFile(newPin(), lanPinPath(dshHome))
}

export async function rotateLanPin(dshHome?: string): Promise<string> {
  return writePinFile(newPin(), lanPinPath(dshHome))
}
