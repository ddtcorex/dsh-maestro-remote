# Changelog

## [0.2.0] - 2026-09-02

### Added

- Local LAN PIN gate on the canonical `:3080` (spec 2026-09-02 local-pin-gate): the LAN proxy owns `:3080` behind the maestro PIN, the raw webserver moves off it, and the whole LAN is gated with the single public PIN (`lanPort`/`lanHost`/`lanPinEnabled` settings, mapped through `dsh-maestro-config-lib` 0.1.4).
- Fail-closed deployment contract: when the webserver is not on `:3080` and `lanPort` is unset, `ProxyStatus.deploymentError` is surfaced instead of silently serving a topology with a dead canonical URL.

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-09-02

### Fixed

- **Models/settings surfaces now work through the tunnel and LAN proxy.**
  The DSH browser client keys settings persistence to
  `ctx.remote.$host.isLoopback`, which it derives from the page hostname — a
  public tunnel or LAN hostname was never loopback, so the Settings → Models
  tab failed with "settings are unavailable in this browser". The proxy now
  declares `ClientTransportHooks.ownsHost` on every served HTML document
  (behind the existing PIN gate), restoring host-backed settings while leaving
  fetch/RPC and module loading untouched (PR #36).

## [0.1.3] - 2026-09-02

### Changed

- **Startup Telegram notification** is now a single compact block: separator
  blank lines removed, so `Ready` / `PIN` / `Public URL` sit on consecutive
  rows (PR #34).
- Dependency refresh: `@deepseek-ai/*` → `0.1.2-alpha.2`, `cordis` → `4.0.2`
  (PR #33).

### Removed

- **LAN URL row** from the startup notification — the address was only usable
  from inside the same LAN and leaked a local IP into the message.
- **Proxy status block** (including the `⚠️ Proxy` failure lines) from the
  startup notification; the message now carries readiness, PIN and the public
  URL only.

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

[0.1.3]: https://github.com/ddtcorex/dsh-maestro-remote/releases/tag/v0.1.3
[0.1.0]: https://github.com/ddtcorex/dsh-maestro-remote/releases/tag/v0.1.0
