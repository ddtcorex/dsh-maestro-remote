import { randomInt } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PIN_RE = /^\d{8}$/

export function pinPath(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-maestro-remote', 'pin')
}

function legacyPinPath(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-maestro-remote', 'token')
}

function legacyLanPinPath(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-maestro-remote', 'token-lan')
}

/** LAN PIN lives in its own file so rotating the public PIN cannot invalidate LAN links. */
export function lanPinPath(dshHome?: string): string {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-maestro-remote', 'pin-lan')
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

/** Current PIN, generating and persisting one when absent or malformed. Migrates legacy `token` file. */
export async function readPin(dshHome?: string): Promise<string> {
  try {
    const existing = (await readFile(pinPath(dshHome), 'utf-8')).trim()
    if (PIN_RE.test(existing)) return existing
  } catch { /* absent or unreadable — try legacy */ }
  try {
    const legacy = (await readFile(legacyPinPath(dshHome), 'utf-8')).trim()
    if (PIN_RE.test(legacy)) {
      // migrate to new location for future reads
      await writePinFile(legacy, pinPath(dshHome))
      return legacy
    }
  } catch { /* legacy absent — generate below */ }
  return writePinFile(newPin(), pinPath(dshHome))
}

export async function writePin(pin: string, dshHome?: string): Promise<string> {
  return writePinFile(pin, pinPath(dshHome))
}

export async function rotatePin(dshHome?: string): Promise<string> {
  return writePinFile(newPin(), pinPath(dshHome))
}

/** Current LAN PIN, generating and persisting one when absent or malformed. Migrates legacy `token-lan` file. */
export async function readLanPin(dshHome?: string): Promise<string> {
  try {
    const existing = (await readFile(lanPinPath(dshHome), 'utf-8')).trim()
    if (PIN_RE.test(existing)) return existing
  } catch { /* absent — try legacy */ }
  try {
    const legacy = (await readFile(legacyLanPinPath(dshHome), 'utf-8')).trim()
    if (PIN_RE.test(legacy)) {
      await writePinFile(legacy, lanPinPath(dshHome))
      return legacy
    }
  } catch {}
  return writePinFile(newPin(), lanPinPath(dshHome))
}

export async function rotateLanPin(dshHome?: string): Promise<string> {
  return writePinFile(newPin(), lanPinPath(dshHome))
}
