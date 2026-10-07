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

## Requirements

- Node.js `^22.19.0 || >=24.0.0` and pnpm 11+. A shell that defaults to Node 20 fails with `No such built-in module: node:sqlite`; put a Node 22 `bin` first on `PATH` before running `dsh` or `pnpm`.
- DSH 0.1.x or 0.2.x (peer range `<0.3.0-0`).

## Install

```sh
dsh plugin --profile web add @ddtcorex/dsh-maestro-remote
```

The package ships its own `cordis.patch.yml`, applied automatically. It includes a
`connection` entry that declares `webServer`, which DSH 0.2.x needs before
`rpc.handle` can register a channel. Do not copy it into the profile patch, and do not
add the rows by hand (duplicate ids crash the loader). Restart `dsh web` after install.

To get an exact release instead of whatever the package manager resolves, pin it:
`dsh plugin --profile web add @ddtcorex/dsh-maestro-remote@<version>`.

Installed with `link:` from a checkout? After every `git pull`, run `pnpm install && pnpm build`
(`lib/` is gitignored) and restart `dsh web`.

## Putting the PIN in front of a tunnel

The proxy listens on port `3081` by default (`proxyPort` in the settings store; it walks up
to 9 ports if that one is busy). A named tunnel whose ingress still points at the raw
`dsh web` port bypasses the PIN, so point the tunnel `service:` at the proxy port instead.
The 8-digit PIN lives in `~/.dsh/dsh-maestro-remote/pin` (created on first use); rotate it
from Settings > Maestro Remote. The PIN cookie lifetime is `pinSessionTtlHours`.

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
