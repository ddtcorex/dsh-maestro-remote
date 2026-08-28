# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-28

Initial release of `@ddtcorex/dsh-maestro-remote` — remote access plugin for
DeepSeek Harness: Cloudflare tunnel (quick or named) + LAN remote proxy, PIN-auth
with QR provisioning and startup Telegram notifications.

### Added

- **Tunnel lifecycle** (`maestroTunnel` service): start/stop/status of a
  cloudflared quick tunnel or a named tunnel (ingress `/hooks/*` → GitLab
  webhook, everything else → remote proxy), auto-restore of a previously running
  named tunnel on boot. Reversible via `ctx.effect` disposers.
- **Remote proxy**: request handler for the tunnel target with PIN auth
  (constant-time comparison via `secure-compare.ts`), reloadable config and LAN
  URL helpers.
- **cloudflared fetcher** (`cloudflared-fetch.ts`): resolves the binary from
  `PATH` or installs it into a cache dir.
- **Config / PIN stores** (`config-store.ts`, `pin-store.ts`): shared
  namespaced settings store (`~/.dsh/maestro/settings.json` via
  `@ddtcorex/dsh-maestro-config-lib`) for user config; per-package sidecar
  `runtime.json` for machine state (`lastTunnelRunning`).
- **Startup notification** (`startup-notify.ts`): schedules the protected
  "DSH web is ready" update via the optional `maestroNotifier` service
  (provided by `@ddtcorex/dsh-maestro-notifier`).
- **Loopback RPC** (`src/host/index.ts`): `/dsh-maestro-remote` channel
  (`authority: loopback`) with `status` endpoint.
- **Client half** (`client/`): settings + tunnel status UI via injected slots.

[0.1.0]: https://github.com/ddtcorex/dsh-maestro-remote/releases/tag/v0.1.0
