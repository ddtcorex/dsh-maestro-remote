import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  });
});
