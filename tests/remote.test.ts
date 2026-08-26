import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteProxy, type RemoteProxyHandle } from '../src/remote-proxy.ts';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolveGet, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolveGet({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function buildClientAssets(): Promise<void> {
  const builder = resolve(packageRoot, 'client/build.mjs');
  // Before the production builder exists, keep this test focused on the
  // package's observable unbuilt-asset behavior rather than a missing helper.
  if (existsSync(builder)) await execFileAsync(process.execPath, [builder], { cwd: packageRoot });
}

/** Mirrors build.mjs's own ancestor search: null where no DSH checkout sits beside the package (e.g. CI). */
function findDeepseekHarness(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = resolve(dir, 'deepseek-harness');
    if (existsSync(resolve(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const dshRepo = findDeepseekHarness(packageRoot);

function findPatch(): string {
  const candidates = [
    'packages/dsh-maestro-remote/cordis.patch.yml',
    'cordis.patch.yml',
    resolve(dirname(fileURLToPath(import.meta.url)), '../cordis.patch.yml'),
    resolve(process.cwd(), 'cordis.patch.yml'),
    resolve(process.cwd(), 'packages/dsh-maestro-remote/cordis.patch.yml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  throw new Error('cordis.patch.yml not found in candidates: ' + candidates.join(', '));
}

function existsTunnel(): boolean {
  const candidates = [
    'packages/dsh-maestro-remote/src/tunnel.ts',
    'src/tunnel.ts',
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/tunnel.ts'),
    resolve(process.cwd(), 'src/tunnel.ts'),
    resolve(process.cwd(), 'packages/dsh-maestro-remote/src/tunnel.ts'),
  ];
  return candidates.some(p => existsSync(p));
}

describe('dsh-maestro-remote', () => {
  it('has cordis patch with maestro-remote id', () => {
    const yml = findPatch();
    expect(yml).toContain('maestro-remote');
  });

  it('has tunnel.ts copied', () => {
    expect(existsTunnel()).toBe(true);
  });

  it('package.json has correct dsh metadata', () => {
    const candidates = [
      'packages/dsh-maestro-remote/package.json',
      'package.json',
      resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'),
      resolve(process.cwd(), 'package.json'),
      resolve(process.cwd(), 'packages/dsh-maestro-remote/package.json'),
    ];
    let pkg: any = null;
    for (const p of candidates) {
      if (existsSync(p)) { pkg = JSON.parse(readFileSync(p, 'utf8')); break; }
    }
    expect(pkg).not.toBeNull();
    expect(pkg.name).toBe('@ddtcorex/dsh-maestro-remote');
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml');
    // Host-only today: a dsh.client declaration without an exports['./client']
    // bundle hard-throws the whole web boot (client-modules index.ts:453).
    expect(pkg.dsh.client).toBeUndefined();
  });
});

describe('cordis.patch.yml row wiring', () => {
  it('loads both the rpc entry and the tunnel provider', () => {
    const yml = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../cordis.patch.yml'), 'utf8');
    expect(yml).toContain("name: '@ddtcorex/dsh-maestro-remote/lib/index.js'");
    expect(yml).toContain("name: '@ddtcorex/dsh-maestro-remote/lib/tunnel.js'");
    // Rows import deep subpaths, so the exports map must expose ./lib/*.
    const pkg2 = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
    expect(pkg2.exports['./lib/*']).toBe('./lib/*');
  });
});

describe('remote login page', () => {
  let proxy: RemoteProxyHandle;

  async function startProxy(): Promise<RemoteProxyHandle> {
    return createRemoteProxy({
      port: 0,
      host: '127.0.0.1',
      upstream: { host: '127.0.0.1', port: 1 },
      auth: {
        isPublic: (host) => host === 'public.example.com',
        getPin: async () => 'test-pin',
      },
    });
  }

  it('renders a native PIN fallback before the enhancement bundle loads', async () => {
    proxy = await startProxy();
    try {
      const page = await get(proxy.port, '/', { host: 'public.example.com', accept: 'text/html' });
      expect(page.body).toContain('<form');
      expect(page.body).toContain('action="/maestro-login"');
      expect(page.body).toContain('name="token"');
      // Same design-system look as the enhanced React form, not a bare
      // browser-default input/button — see login-extras.css.
      expect(page.body).toContain('class="maestro-login-card"');
      expect(page.body).toContain('class="maestro-login-submit"');
      // Dark mode is applied via body[data-ds-dark-theme], set by JS — without
      // this inline script the fallback would always render light-themed.
      expect(page.body).toContain("matchMedia('(prefers-color-scheme: dark)')");
    } finally {
      await proxy.close();
    }
  });

  it('serves built login assets from the package default directory', async () => {
    await buildClientAssets();
    proxy = await startProxy();
    try {
      const js = await get(proxy.port, '/__maestro/login.js', { host: 'public.example.com' });
      const css = await get(proxy.port, '/__maestro/login.css', { host: 'public.example.com' });
      if (dshRepo === null) {
        // No DeepSeek Harness checkout in this environment (e.g. CI): the
        // builder skips and the assets 404 — the native fallback form covers it.
        expect(js.status).toBe(404);
        expect(css.status).toBe(404);
        return;
      }
      expect(js.status).toBe(200);
      expect(js.body.length).toBeGreaterThan(0);
      expect(css.status).toBe(200);
      expect(css.body.length).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  });

  // Only meaningful where a real DeepSeek Harness checkout sits beside the
  // package (the maestro-harness workspace) — CI and a standalone clone have
  // nothing for the ancestor search to find.
  it.skipIf(dshRepo === null)('builds login assets from a normal package checkout without DSH_REPO', async () => {
    const workspace = await mkdtemp(resolve(tmpdir(), 'maestro-remote-build-'));
    const normalPackage = resolve(workspace, 'packages/dsh-maestro-remote');
    try {
      await mkdir(normalPackage, { recursive: true });
      await cp(resolve(packageRoot, 'client'), resolve(normalPackage, 'client'), { recursive: true });
      await cp(resolve(packageRoot, 'package.json'), resolve(normalPackage, 'package.json'));
      await symlink(resolve(packageRoot, 'node_modules'), resolve(normalPackage, 'node_modules'), 'dir');
      await symlink(resolve(packageRoot, '../../deepseek-harness'), resolve(workspace, 'deepseek-harness'), 'dir');

      await execFileAsync(process.execPath, [resolve(normalPackage, 'client/build.mjs')], {
        cwd: normalPackage,
        env: { ...process.env, DSH_REPO: '' },
      });

      expect(readFileSync(resolve(normalPackage, 'client/login.js')).length).toBeGreaterThan(0);
      expect(readFileSync(resolve(normalPackage, 'client/login.css')).length).toBeGreaterThan(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
