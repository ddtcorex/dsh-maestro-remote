import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { firstMeaningfulErrorLine, namedTunnelArgs, quickTunnelTimeoutMessage, startNamedTunnel } from '../src/host/tunnel.ts'

const { mockSpawn, children } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  children: [] as Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void }>,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Array<unknown>) => mockSpawn(...args) }
})

beforeEach(() => {
  children.length = 0
  mockSpawn.mockReset()
  mockSpawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {},
    })
    children.push(child)
    return child
  })
})

describe('namedTunnelArgs', () => {
  it('runs the named tunnel with --no-autoupdate so it never restarts itself mid-session', () => {
    expect(namedTunnelArgs('/tmp/cloudflared-config.yml', 'test-tunnel')).toEqual([
      'tunnel',
      '--no-autoupdate',
      '--config',
      '/tmp/cloudflared-config.yml',
      'run',
      'test-tunnel',
    ])
  })

  it('passes that argv to cloudflared', () => {
    startNamedTunnel({ configPath: '/tmp/cloudflared-config.yml', tunnelId: 'test-tunnel' })
    expect(mockSpawn).toHaveBeenCalledWith(
      'cloudflared',
      ['tunnel', '--no-autoupdate', '--config', '/tmp/cloudflared-config.yml', 'run', 'test-tunnel'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
  })
})

describe('firstMeaningfulErrorLine', () => {
  it('returns the failing line, never the usage tail', () => {
    const output = [
      'Incorrect Usage: flag provided but not defined: -bogus',
      '',
      'NAME:',
      '   cloudflared - Cloudflare Tunnel client (built 2024-01-01)',
      '',
      'USAGE:',
      '   cloudflared [global options] command [command options] [arguments...]',
    ].join('\n')
    expect(firstMeaningfulErrorLine(output)).toBe('Incorrect Usage: flag provided but not defined: -bogus')
  })

  it('returns undefined for a pure help block and for empty output', () => {
    const help = [
      'NAME:',
      '   cloudflared - Cloudflare Tunnel client',
      '',
      'USAGE:',
      '   cloudflared [global options] command',
    ].join('\n')
    expect(firstMeaningfulErrorLine(help)).toBeUndefined()
    expect(firstMeaningfulErrorLine('')).toBeUndefined()
  })

  it('falls back to the first line that is not help text', () => {
    expect(firstMeaningfulErrorLine('Cannot determine the origin URL of your origin\n\nUSAGE:\n   cloudflared ...')).toBe(
      'Cannot determine the origin URL of your origin',
    )
  })

  it('handles CRLF output', () => {
    expect(firstMeaningfulErrorLine('failed to run tunnel: no such host\r\nUSAGE:\r\n   cloudflared ...')).toBe(
      'failed to run tunnel: no such host',
    )
  })
})

describe('quickTunnelTimeoutMessage', () => {
  it('reports the first meaningful line instead of the usage tail', () => {
    const message = quickTunnelTimeoutMessage(30_000, 'Incorrect Usage: unknown flag\n\nUSAGE:\n   cloudflared ...')
    expect(message).toContain('timed out after 30000ms')
    expect(message).toContain('Incorrect Usage: unknown flag')
    expect(message).not.toContain('USAGE:')
  })

  it('still explains the tunnel-blocking cause when cloudflared said nothing', () => {
    expect(quickTunnelTimeoutMessage(30_000, '')).toContain('cloudflared printed no reason')
    expect(quickTunnelTimeoutMessage(30_000, '')).toContain('TUN mode')
  })
})

describe('named tunnel output', () => {
  it('keeps the child output so an unexpected exit can name the reason', () => {
    const handle = startNamedTunnel({ configPath: '/tmp/cloudflared-config.yml', tunnelId: 'test-tunnel' })
    children[0]?.stderr.write('Incorrect Usage: flag provided but not defined: -bogus\nUSAGE:\n   cloudflared ...\n')
    expect(firstMeaningfulErrorLine(handle.output())).toBe('Incorrect Usage: flag provided but not defined: -bogus')
  })
})
