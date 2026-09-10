import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockSpawn, children, configState } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  children: [] as FakeChild[],
  configState: { lastTunnelRunning: true, saved: [] as Array<Record<string, unknown>> },
}));

class FakeChild extends EventEmitter {
  stdout = null;
  stderr = null;
  kill = vi.fn();
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Array<unknown>) => mockSpawn(...args) };
});

vi.mock('../src/host/config-store.ts', () => ({
  loadUserConfig: async () => ({
    tunnelMode: 'named',
    tunnelId: 'test-tunnel-id',
    tunnelCredentialsFile: '/tmp/test-cred.json',
    tunnelHostname: 'test.example.com',
    proxyPort: 38123,
    lastTunnelRunning: configState.lastTunnelRunning,
  }),
  saveUserConfig: async (patch: Record<string, unknown>) => {
    configState.saved.push(patch);
    if ('lastTunnelRunning' in patch) {
      configState.lastTunnelRunning = patch.lastTunnelRunning as boolean;
    }
    return patch;
  },
}));

vi.mock('../src/host/remote-proxy.ts', () => ({
  createRemoteProxy: async () => ({ port: 38123, close: async () => {} }),
  isPublicHost: () => false,
  lanUrls: () => [],
}));

vi.mock('../src/host/pin-store.ts', () => ({
  readPin: async () => '11111111',
  readLanPin: async () => '22222222',
  rotatePin: async () => '11111111',
  rotateLanPin: async () => '22222222',
}));

vi.mock('../src/host/startup-notify.ts', () => ({
  scheduleStartupNotification: () => {},
}));

import { apply } from '../src/host/tunnel.ts';

describe('tunnel apply() self-healing', () => {
  let dshHome: string;
  let realDshHome: string | undefined;
  let provided: any;
  let ctx: any;

  beforeEach(async () => {
    realDshHome = process.env.DSH_HOME;
    dshHome = await mkdtemp(join(tmpdir(), 'dsh-watchdog-'));
    process.env.DSH_HOME = dshHome;
    configState.lastTunnelRunning = true;
    configState.saved = [];
    children.length = 0;
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    provided = undefined;
    ctx = {
      // Cordis semantics: the effect callback runs as setup and its return
      // value is kept as the disposer (NOT executed immediately).
      effect: (fn: (...args: Array<unknown>) => unknown) => {
        fn('maestro-tunnel');
        return () => {};
      },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      get: () => undefined,
      provide: (_name: string, value: unknown) => {
        provided = value;
      },
      webServer: { port: 3099 },
    };
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (realDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = realDshHome;
    await rm(dshHome, { recursive: true, force: true });
  });

  /** Let a fired retry's real-filesystem chain (config write) settle. */
  async function flushRetry(): Promise<void> {
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  it('restarts the tunnel after the child dies unexpectedly', async () => {
    apply(ctx);
    await provided.initialReady();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(provided.status().running).toBe(true);

    vi.useFakeTimers();
    children[0].emit('exit', 1);
    expect(provided.status().running).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushRetry();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(provided.status().running).toBe(true);
  });

  it('does not restart after an explicit stop', async () => {
    apply(ctx);
    await provided.initialReady();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    children[0].emit('exit', 1);
    await provided.stop();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(provided.status().running).toBe(false);
  });

  it('retries a boot-time start failure', async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('spawn ENOENT');
    });
    vi.useFakeTimers();
    apply(ctx);
    await provided.initialReady();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(provided.status().running).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushRetry();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(provided.status().running).toBe(true);
  });
});
