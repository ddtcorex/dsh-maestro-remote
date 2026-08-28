# AGENTS.md — dsh-maestro-remote

> `CLAUDE.md` at the repo root is a symlink to `AGENTS.md`. Claude Code follows the same rule set as Codex CLI. Only edit `AGENTS.md` — never edit `CLAUDE.md` directly or replace the symlink with a copy.

## Purpose

Remote-access / tunneling plugin for the DeepSeek Harness (DSH): exposes a cloudflared tunnel + remote proxy so a DSH session can be reached remotely, with PIN auth and Telegram notifications.

Names by boundary: npm package = `@ddtcorex/dsh-maestro-remote`; Cordis patch row id = `dsh-maestro-remote`.

Part of the Maestro Harness suite. Host half + client half (settings/slot UI).

## Layout

- `src/host/index.ts` — host `apply()`: wires tunnel + proxy + tools + RPC.
- `src/host/tunnel.ts` — cloudflared tunnel lifecycle (start/stop/status, reversible via `ctx.effect`).
- `src/host/remote-proxy.ts` — the remote proxy handler.
- `src/host/cloudflared-fetch.ts` — fetches/installs the `cloudflared` binary.
- `src/host/startup-notify.ts` — schedules the protected "DSH web is ready" update via the optional
  `maestroNotifier` service (published by `@ddtcorex/dsh-maestro-notifier`); transport only — the
  message text stays here, delivery goes through the pluggable provider registry.
- `src/host/pin-store.ts` — persisted PIN; `src/host/secure-compare.ts` — constant-time comparison.
- `src/host/config-store.ts` — persisted config; `src/host/skills-tool.ts` — skills helper.
- `src/host/augment.d.ts` — local structural types (do NOT import from `deepseek-harness`).
- Client half — settings + tunnel status UI (injected slots).
- `tests/remote.test.ts` + `tests/startup-notify.test.ts` — vitest suites.

## Development

```sh
pnpm verify   # tsc --noEmit
pnpm test     # vitest run
pnpm build    # tsc -p tsconfig.json  -> lib/
```

## Git workflow

- Default branch `master`. No direct commits to `master` — use `feat/<topic>` / `fix/<topic>` and a PR.
- Conventional commits, imperative mood (`feat(remote): ...`, `fix(remote): ...`).
- One TDD task = one commit; never commit while `pnpm verify` is red.
- **Always request approval before merge or release:** never merge a PR/MR or publish a release (`git tag`/`pnpm publish`/`gh release`) without an explicit human approval — request review (`gh pr ready` / `gh pr request-review` / ask in chat) and wait for `APPROVED`. This applies to every `master` merge and every `vX.Y.Z` tag (see `docs/PUBLIC_REPO_CHECKLIST.md` §2/§8).

## Conventions

- **Secrets** — compare PINs/tokens with `secure-compare.ts` (constant-time); never log or echo a PIN/token. No real tokens in tests or fixtures.
- **Tunnel lifecycle** — every process/socket/timer must be reversible: register in `ctx.effect(...)` and return a disposer that tears the tunnel down.
- **Host/client split** — network + process work in the host; the client only renders status/settings via slots and calls host RPC with lossless JSON.
- Keep the config/pin storage consistent with the other `dsh-maestro-*` packages (same layout/atomic-store conventions).

## Validation

`pnpm verify` + `pnpm test` green before any success claim. A tunnel feature must be validated live (a real tunnel start/stop + proxy round-trip), not just via unit tests.
