/**
 * Tunnel and LAN access, the keys `dsh-maestro-remote` owns.
 *
 * Deliberately absent: `lanPort` and `lanHost`. They exist in the store's key
 * map but are machine-local, and a harness sync rewrites `domains.tunnel` from
 * the per-machine tunnel profile, so anything typed here for them is discarded
 * without a word. Showing the fields would be a lie about where they come from.
 */
import * as React from 'react'
import type { RpcCall } from '../index.js'
import { BrandBadge } from '../BrandMark.js'

const PIN_TTL_PRESETS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 0, label: 'Session only' },
  { hours: 1, label: '1 hour' },
  { hours: 8, label: '8 hours' },
  { hours: 24, label: '1 day (default)' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
]

const MAX_PIN_TTL_HOURS = 8760

/**
 * One setting, in the house pattern's two-column row: label and hint left,
 * control held right. `htmlFor`/`id` are what give the control its accessible
 * name — the previous markup rendered a bare `<label>` beside an input with no
 * `id`, so nothing was associated.
 */
function Field(props: { id: string; label: string; hint?: React.ReactNode; children?: React.ReactNode }) {
  return React.createElement(
    'div',
    { 'data-remote-row': '' },
    React.createElement(
      'div',
      { 'data-remote-row-text': '' },
      React.createElement('label', { 'data-remote-label': '', htmlFor: props.id }, props.label),
      props.hint ? React.createElement('p', { 'data-remote-hint': '' }, props.hint) : null,
    ),
    React.createElement('div', { 'data-remote-control': '' }, props.children),
  )
}

export function TunnelSettings(props: { rpcCall: RpcCall }) {
  const { rpcCall } = props
  const [status, setStatus] = React.useState<any>(null)
  const [pin, setPin] = React.useState<string>('')
  const [lan, setLan] = React.useState<{ enabled: boolean; pin?: string } | null>(null)
  const [hostname, setHostname] = React.useState('')
  const [ttl, setTtl] = React.useState<number>(24)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  const fail = React.useCallback((e: unknown) => {
    setNotice({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
  }, [])

  const refresh = React.useCallback(async () => {
    setBusy(true)
    try {
      const [s, p, l] = await Promise.all([
        rpcCall('maestro.status'),
        rpcCall('maestro.getPin').then((v: any) => v?.pin ?? '').catch(() => ''),
        rpcCall('maestro.lanPin.status').catch(() => ({ enabled: false })),
      ])
      setStatus(s)
      setPin(p)
      setLan(l)
      const cfg = await rpcCall('maestro.getConfig').catch(() => null)
      if (cfg) {
        // `maestro.getConfig` answers the raw NESTED `domains.tunnel`, whose
        // hostname key is `hostname`. `tunnelHostname` is the FLAT alias the
        // store's key map translates onto `tunnel.hostname`; reading it here
        // always missed, and writing it created a key nothing read back.
        if (typeof cfg.hostname === 'string') setHostname(cfg.hostname)
        if (typeof cfg.pinSessionTtlHours === 'number') setTtl(cfg.pinSessionTtlHours)
      }
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }, [rpcCall, fail])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const save = React.useCallback(
    async (patch: Record<string, unknown>) => {
      setBusy(true)
      try {
        await rpcCall('maestro.saveConfig', patch)
        setNotice({ tone: 'ok', text: 'Saved.' })
        await refresh()
      } catch (e) {
        fail(e)
      } finally {
        setBusy(false)
      }
    },
    [rpcCall, refresh, fail],
  )

  const act = React.useCallback(
    async (endpoint: string, then?: () => void) => {
      setBusy(true)
      try {
        await rpcCall(endpoint, {})
        then?.()
      } catch (e) {
        fail(e)
      } finally {
        setBusy(false)
      }
    },
    [rpcCall, fail],
  )

  // `TunnelStatus` is { running, mode, publicUrl, phase }. The section read
  // `status` and `tunnelRunning` — neither of which the host emits — so a live
  // tunnel rendered as stopped with a Start button.
  const running = status?.running === true
  const phase: string | undefined = typeof status?.phase === 'string' ? status.phase : undefined

  return React.createElement(
    'div',
    { 'data-remote-root': '' },
    // House header: badge, title, one-line status. The notice lives here so it
    // reports without pushing the rows down.
    React.createElement(
      'div',
      { 'data-remote-header': '' },
      React.createElement(BrandBadge as any, { style: { alignSelf: 'flex-start', marginTop: 2 } }),
      React.createElement(
        'div',
        { 'data-remote-heading': '' },
        React.createElement('h2', { 'data-remote-title': '' }, 'Tunnel and LAN access'),
        React.createElement(
          'div',
          { 'data-remote-status': '' },
          notice
            ? React.createElement('p', { 'data-remote-notice': '', 'data-tone': notice.tone, role: 'status' }, notice.text)
            : React.createElement('span', null,
                running
                  ? (phase === 'ready' ? 'Tunnel running.' : `Tunnel ${phase ?? 'starting'}…`)
                  : (phase === 'error' ? `Tunnel error: ${status?.errorMessage ?? 'unknown'}` : 'Tunnel stopped.'),
              ),
        ),
      ),
    ),

    React.createElement(
      'div',
      { 'data-remote-actions': '' },
      React.createElement('button', { type: 'button', disabled: busy, onClick: () => void refresh() }, 'Refresh'),
      running
        ? React.createElement('button', { type: 'button', disabled: busy, onClick: () => void act('maestro.tunnelStop', () => void refresh()) }, 'Stop tunnel')
        : React.createElement('button', { type: 'button', disabled: busy, onClick: () => void act('maestro.tunnelStart', () => void refresh()) }, 'Start tunnel'),
      React.createElement('button', { type: 'button', disabled: busy, onClick: () => void act('maestro.rotatePin', () => void refresh()) }, 'Rotate public PIN'),
    ),

    Field({
      id: 'remote-tunnel-hostname',
      label: 'Public hostname',
      hint: 'Leave blank for the quick target configured on the server.',
      children: React.createElement('input', {
        id: 'remote-tunnel-hostname',
        type: 'text',
        value: hostname,
        placeholder: 'dsh.example.com',
        disabled: busy,
        'data-remote-input': 'hostname',
        onChange: (e: any) => setHostname(e.target.value),
        // `hostname` is the key `maestro.getConfig` answers and the key the
        // tunnel reads. `tunnelHostname` is the store's FLAT alias; sending it
        // wrote `domains.tunnel.tunnelHostname`, which nothing reads back.
        onBlur: () => void save({ hostname }),
      }),
    }),

    Field({
      id: 'remote-public-pin',
      label: 'Public PIN',
      children: React.createElement('div', { 'data-remote-pin': '' },
        React.createElement('code', null, pin || '(not read yet)'),
        ' ',
        React.createElement('button', { type: 'button', disabled: busy, onClick: () => void act('maestro.rotatePin', () => void refresh()) }, 'Rotate'),
      ),
    }),

    Field({
      id: 'remote-pin-ttl',
      label: 'PIN session lifetime',
      hint: '0 is a session cookie. The host caps this at one year.',
      children: React.createElement('select', {
        id: 'remote-pin-ttl',
        value: String(ttl),
        disabled: busy,
        'data-remote-select': 'pinSessionTtlHours',
        onChange: (e: any) => setTtl(Number(e.target.value)),
        onBlur: () => void save({ pinSessionTtlHours: ttl }),
      }, PIN_TTL_PRESETS.map((p) =>
        React.createElement('option', { key: p.hours, value: String(p.hours) }, p.label),
      )),
    }),

    Field({
      id: 'remote-lan-pin',
      label: 'LAN PIN',
      hint: 'Off by default. Turning it on generates a LAN PIN on this machine.',
      children: React.createElement('div', { 'data-remote-lan': '' },
        React.createElement('input', {
          id: 'remote-lan-pin',
          type: 'checkbox',
          checked: lan?.enabled === true,
          disabled: busy,
          'data-remote-toggle': 'lanPin',
          onChange: () => void act('maestro.lanPin.setEnabled', () => void refresh()),
        }),
        lan?.enabled ? React.createElement('code', null, ` ${lan.pin ?? ''}`) : null,
        lan?.enabled
          ? React.createElement('button', { type: 'button', disabled: busy, onClick: () => void act('maestro.lanPin.rotate', () => void refresh()) }, ' Rotate')
          : null,
      ),
    }),
  )
}

export { MAX_PIN_TTL_HOURS }