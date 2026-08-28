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
  try {
    const existing = (await readFile(lanPinPath(dshHome), 'utf-8')).trim()
    if (PIN_RE.test(existing)) return existing
  } catch { /* absent or unreadable — generate below */ }
  return writePinFile(newPin(), lanPinPath(dshHome))
}

export async function rotateLanPin(dshHome?: string): Promise<string> {
  return writePinFile(newPin(), lanPinPath(dshHome))
}
