import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/host/tunnel.ts';

let home: string;
let previousDshHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'remote-pin-'));
  previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
});

afterEach(async () => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousDshHome;
  await rm(home, { recursive: true, force: true });
});

interface MaestroTunnelPinSurface {
  getPin(): Promise<string>;
  rotatePin(): Promise<string>;
  getLanPin(): Promise<string>;
  rotateLanPin(): Promise<string>;
  stop(): Promise<unknown>;
}

/** Minimal fake ctx: captures whatever apply() provides as 'maestroTunnel', runs effects eagerly. */
function makeCtx(): { ctx: any; teardown: () => void } {
  const disposers: Array<() => void> = [];
  const ctx: any = {
    webServer: { port: 1 },
    effect: (fn: () => (() => void) | void) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    provide: (name: string, value: unknown) => { ctx[name] = value; },
    get: () => undefined,
    logger: undefined,
  };
  return { ctx, teardown: () => { for (const d of disposers) d(); } };
}

describe('maestroTunnel PIN passthrough', () => {
  it('exposes getPin/rotatePin backed by the real, persisted PIN store — not a hardcoded stub', async () => {
    const { ctx, teardown } = makeCtx();
    try {
      apply(ctx);
      const tunnel = ctx.maestroTunnel as MaestroTunnelPinSurface;

      const initial = await tunnel.getPin();
      expect(initial).toMatch(/^\d{8}$/);

      const rotated = await tunnel.rotatePin();
      expect(rotated).toMatch(/^\d{8}$/);
      expect(rotated).not.toBe(initial);
      // Persisted, not just returned — the proxy reads this same file on every request.
      const onDisk = (await readFile(join(home, 'dsh-maestro-remote', 'pin'), 'utf-8')).trim();
      expect(onDisk).toBe(rotated);

      const readBack = await tunnel.getPin();
      expect(readBack).toBe(rotated);
    } finally {
      await ctx.maestroTunnel?.stop();
      teardown();
    }
  });

  it('exposes getLanPin/rotateLanPin backed by a separate persisted LAN PIN store', async () => {
    const { ctx, teardown } = makeCtx();
    try {
      apply(ctx);
      const tunnel = ctx.maestroTunnel as MaestroTunnelPinSurface;

      const rotated = await tunnel.rotateLanPin();
      expect(rotated).toMatch(/^\d{8}$/);
      const onDisk = (await readFile(join(home, 'dsh-maestro-remote', 'pin-lan'), 'utf-8')).trim();
      expect(onDisk).toBe(rotated);

      // Rotating the LAN PIN must not disturb the public PIN file.
      const publicPin = await tunnel.getPin();
      expect(publicPin).not.toBe(rotated);
    } finally {
      await ctx.maestroTunnel?.stop();
      teardown();
    }
  });
});
