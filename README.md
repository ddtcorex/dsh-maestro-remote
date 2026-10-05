# @ddtcorex/dsh-maestro-remote

Remote access plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
a Cloudflare tunnel (quick or named) plus a LAN remote proxy so a DSH session can be reached
from outside the machine, gated by a second PIN with QR provisioning.

Part of the Maestro Harness suite (`dsh-maestro-*`). Three Cordis patch rows:
`dsh-maestro-remote-rpc` (loopback RPC), `dsh-maestro-tunnel` (the tunnel and LAN proxy provider)
and `maestro-patch` (the zero-fork patch shim absorbed from `dsh-maestro-patch`).

## What it provides

- **Tunnel lifecycle** (`maestroTunnel` service): start/stop/status of a cloudflared
  quick tunnel or a named tunnel with a single ingress to the PIN-gated remote proxy, which
  exempts `/hooks/gitlab-mr` and `/hooks/gitlab-mr/trigger` from the PIN so GitLab can post
  webhooks; auto-restore of a previously running named tunnel on boot.
- **Remote proxy**: request handler for the tunnel target with PIN auth
  (constant-time comparison), reloadable config.
- **cloudflared fetcher**: resolves the binary from PATH or installs it into a cache dir.

## Settings

Config persists through the **embedded settings store**: a committed, hash-sealed copy of
`dsh-maestro-core`'s store (`src/host/vendor/store.ts`), reading and writing the shared
namespaced document `~/.dsh/dsh-maestro-config/settings.json` through a flat
`MaestroUserConfig` adapter, see `src/host/config-store.ts`. This package does not depend on a
published settings library. Machine runtime state
(`lastTunnelRunning`) deliberately lives in this package's own sidecar
(`~/.dsh/dsh-maestro-remote/runtime.json`) so editing settings can never silently flip
tunnel state.

## Install

```sh
dsh plugin --profile web add @ddtcorex/dsh-maestro-remote
```

## Development

```sh
pnpm install
pnpm verify   # tsc --noEmit
pnpm test     # vitest run
pnpm build    # tsc host + tsc client + esbuild bundle -> lib/ and lib/client.js
```

A tunnel change must be validated live (real start/stop + proxy round-trip), not just by unit
tests — see AGENTS.md.

## License

MIT
