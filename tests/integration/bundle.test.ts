import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundlePath = path.join(root, 'dist', 'frankentty.cjs');
const pkgVersion = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string })
  .version;

function runBundle(args: string[]) {
  return spawnSync(process.execPath, [bundlePath, ...args], { cwd: root, encoding: 'utf8', input: '' });
}

describe('[REQ-DIST-01] CJS bundle', () => {
  beforeAll(() => {
    const r = spawnSync(process.execPath, ['scripts/bundle.mjs'], { cwd: root, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`bundle: dist/frankentty.cjs (`);
    expect(r.stdout).toContain(`version ${pkgVersion})`);
  }, 60_000);

  it('contains no import.meta', () => {
    expect(readFileSync(bundlePath, 'utf8')).not.toContain('import.meta');
  });

  it('starts with a node shebang', () => {
    expect(readFileSync(bundlePath, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('[REQ-CLI-01] --version prints the package.json version', () => {
    const r = runBundle(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${pkgVersion}\n`);
  }, 60_000);

  it('--help exits 0 and prints usage', () => {
    const r = runBundle(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage');
  }, 60_000);

  it('[REQ-CLI-02] an unknown flag exits 2', () => {
    const r = runBundle(['--no-such-flag']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--no-such-flag');
  }, 60_000);
});
