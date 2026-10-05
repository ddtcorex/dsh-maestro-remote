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
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { TunnelSettings } from '../src/client/remote/TunnelSettings.js'

function rpc(over: Record<string, unknown> = {}) {
  return vi.fn(async (endpoint: string) => {
    switch (endpoint) {
      case 'maestro.status':
        return { status: 'running', tunnelRunning: true }
      case 'maestro.getPin':
        return { pin: '93847651' }
      case 'maestro.lanPin.status':
        return { enabled: true, pin: '64946779' }
      case 'maestro.getConfig':
        return { tunnelHostname: 'tunnel.example.com', pinSessionTtlHours: 24 }
      default:
        return over[endpoint] ?? {}
    }
  }) as any
}

afterEach(cleanup)

describe('TunnelSettings', () => {
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