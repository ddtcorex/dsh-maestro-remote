# @ddtcorex/dsh-maestro-remote

Remote access plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a Cloudflare tunnel (quick or named) plus a LAN remote proxy so a DSH session can be reached
from outside the machine, gated by a second PIN with QR provisioning.

Part of the Maestro Harness suite (`dsh-maestro-*`). Cordis patch row id: `dsh-maestro-remote`
(short alias `maestro-remote` in the meta bundle).

## What it provides

- **Tunnel lifecycle** (`maestroTunnel` service): start/stop/status of a cloudflared
  quick tunnel or a named tunnel (ingress `/hooks/*` → gitlab webhook, everything else → the
  remote proxy), auto-restore of a previously running named tunnel on boot.
- **Remote proxy**: request handler for the tunnel target with PIN auth
  (constant-time comparison), reloadable config.
- **cloudflared fetcher**: resolves the binary from PATH or installs it into a cache dir.

## Settings

Config persists through the **shared namespaced settings store**
(`~/.dsh/maestro/settings.json`, owned by `@ddtcorex/dsh-maestro-config-lib`) via a flat
`MaestroUserConfig` adapter — see `src/config-store.ts`. Machine runtime state
(`lastTunnelRunning`) deliberately lives in this package's own sidecar
(`~/.dsh/dsh-maestro-remote/runtime.json`) so editing settings can never silently flip
tunnel state.

## Install

```sh
dsh plugin --profile web add @ddtcorex/dsh-maestro-remote
# or everything at once:
dsh plugin --profile web add @ddtcorex/dsh-maestro-meta
```

## Development

```sh
pnpm install
pnpm verify   # tsc --noEmit
pnpm test     # vitest run
pnpm build    # tsc -> lib/
```

A tunnel change must be validated live (real start/stop + proxy round-trip), not just by unit
tests — see AGENTS.md.

## License

MIT
