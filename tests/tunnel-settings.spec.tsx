// @vitest-environment jsdom
/**
 * The tunnel and LAN section as the shell mounts it.
 *
 * This package had no DOM spec before, so nothing here observed what the
 * section renders — the gap a sibling package's ReferenceError shipped through
 * with verify, 1240 tests and a clean dry-boot log all green.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import * as React from 'react'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { TunnelSettings } from '../src/client/remote/TunnelSettings.js'

/**
 * The fixture mirrors what the host ACTUALLY returns, measured against the live
 * profile (2026-10-05):
 *
 *   maestro.status    → { running, mode, publicUrl, phase, errorMessage? }
 *   maestro.getConfig → the raw `domains.tunnel` NESTED domain:
 *                       { mode, id, credentialsFile, hostname, lanPort,
 *                         lanHost, lanPinEnabled, pinSessionTtlHours }
 *
 * An earlier revision of this spec answered `tunnelRunning` and
 * `tunnelHostname` — names the host does not emit — so it passed against a
 * fixture shaped like the bug. Fixtures must mirror the real response.
 */
function rpc(over: Record<string, unknown> = {}) {
  return vi.fn(async (endpoint: string) => {
    switch (endpoint) {
      case 'maestro.status':
        return { running: true, mode: 'named', publicUrl: 'https://tunnel.example.com', phase: 'ready' }
      case 'maestro.getPin':
        return { pin: '93847651' }
      case 'maestro.lanPin.status':
        return { enabled: true, pin: '64946779' }
      case 'maestro.getConfig':
        return {
          mode: 'named',
          id: 'a6a31b92',
          credentialsFile: '/home/user/.cloudflared/a6a31b92.json',
          hostname: 'tunnel.example.com',
          lanPort: 3080,
          lanHost: '0.0.0.0',
          lanPinEnabled: true,
          pinSessionTtlHours: 24,
        }
      default:
        return over[endpoint] ?? {}
    }
  }) as any
}

afterEach(cleanup)

describe('TunnelSettings', () => {
  it('reports the tunnel state the host actually reports', async () => {
    const { container } = render(<TunnelSettings rpcCall={rpc()} />)

    // `TunnelStatus` is { running, mode, publicUrl, phase }. The section read
    // `status` and `tunnelRunning` — neither exists — so a live tunnel rendered
    // as "Tunnel stopped" with a Start button.
    await waitFor(() => {
      expect(container.querySelector('[data-remote-status]')?.textContent).toMatch(/running/i)
    })
    expect(screen.queryByRole('button', { name: 'Start tunnel' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop tunnel' })).toBeInTheDocument()
  })

  it('shows a stopped tunnel as stopped', async () => {
    const call = vi.fn(async (endpoint: string) => {
      if (endpoint === 'maestro.status') return { running: false, phase: 'idle' }
      if (endpoint === 'maestro.lanPin.status') return { enabled: false }
      if (endpoint === 'maestro.getConfig') return {}
      return {}
    }) as any
    render(<TunnelSettings rpcCall={call} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Start tunnel' })).toBeInTheDocument()
    })
  })

  it('shows the hostname the host stores, under the key it stores it', async () => {
    render(<TunnelSettings rpcCall={rpc()} />)

    // `maestro.getConfig` answers the raw NESTED domain, whose key is
    // `hostname`. The section read the flat alias `tunnelHostname`, which is
    // what `readFlat` maps ONTO `tunnel.hostname` — so the field rendered empty
    // against a tunnel that was serving a hostname the whole time.
    await waitFor(() => {
      expect((screen.getByLabelText('Public hostname') as HTMLInputElement).value).toBe('tunnel.example.com')
    })
  })

  it('saves the hostname under the key the host accepts', async () => {
    const call = rpc()
    render(<TunnelSettings rpcCall={call} />)

    const input = await screen.findByLabelText('Public hostname')
    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('tunnel.example.com')
    })
    await fireEvent.change(input, { target: { value: 'other.example.com' } })
    await fireEvent.blur(input)

    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('maestro.saveConfig', { hostname: 'other.example.com' })
    })
    // The flat alias is what the store's key map translates; sending it writes
    // a key nothing reads back.
    expect(call).not.toHaveBeenCalledWith('maestro.saveConfig', { tunnelHostname: expect.anything() })
  })

  it('mounts and shows the live tunnel state', async () => {
    const { container } = render(<TunnelSettings rpcCall={rpc()} />)

    await waitFor(() => {
      expect(screen.getByText('Tunnel and LAN access')).toBeInTheDocument()
    })
    expect(container.querySelector('[data-remote-pin]')).toBeInTheDocument()
    expect(container.querySelector('[data-remote-lan]')).toBeInTheDocument()
    // A running tunnel offers Stop, not Start.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Stop tunnel' })).toBeInTheDocument()
    })
  })

  it('never offers the machine-local fields', async () => {
    render(<TunnelSettings rpcCall={rpc()} />)

    // lanPort/lanHost live in the per-machine tunnel profile; a harness sync
    // rewrites domains.tunnel from it, so a field here would be a lie.
    await waitFor(() => {
      expect(screen.getByText('Public hostname')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText(/lanPort/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/lanHost/i)).not.toBeInTheDocument()
  })

  it('draws the house pattern: badged header, status line, two-column rows', async () => {
    const { container } = render(<TunnelSettings rpcCall={rpc()} />)

    expect(container.querySelector('[data-maestro-logo]')).toBeInTheDocument()
    // The section already knows whether the tunnel is up; that belongs in the
    // header status line rather than being inferred from which button is shown.
    const status = container.querySelector('[data-remote-status]')
    expect(status).toBeInTheDocument()
    await waitFor(() => {
      expect(status?.textContent).toMatch(/running/i)
    })

    const rows = container.querySelectorAll('[data-remote-row]')
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const row of rows) {
      expect(row.querySelector('[data-remote-row-text]')).toBeInTheDocument()
      expect(row.querySelector('[data-remote-control]')).toBeInTheDocument()
    }
  })

  it('gives every control an accessible name', async () => {
    render(<TunnelSettings rpcCall={rpc()} />)

    await waitFor(() => {
      expect(screen.getByLabelText('Public hostname')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('PIN session lifetime')).toBeInTheDocument()
  })

  it('keeps its actions and their endpoints', async () => {
    const call = rpc()
    render(<TunnelSettings rpcCall={call} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Rotate public PIN' })).toBeInTheDocument()
    })
    screen.getByRole('button', { name: 'Rotate public PIN' }).click()
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith('maestro.rotatePin', {})
    })
  })
})