import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const release = path.join(root, 'release');
const pkgVersion = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string })
  .version;

// Downloads ~100 MB of official Node binaries, so it only runs on request or in CI.
const enabled =
  (process.env.FRANKENTTY_RELEASE_TEST === '1' || Boolean(process.env.CI)) && process.platform !== 'win32';

const hostName = `${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const hostArchive = `frankentty-${hostName}.tar.gz`;

describe.skipIf(!enabled)('build-release.sh --targets host', () => {
  let buildOutput = '';
  const extractDir = path.join(root, 'build', 'release-test');

  beforeAll(() => {
    const r = spawnSync('bash', ['scripts/build-release.sh', '--targets', 'host'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    buildOutput = r.stdout + r.stderr;
    expect(r.status, buildOutput).toBe(0);
    rmSync(extractDir, { recursive: true, force: true });
    mkdirSync(extractDir, { recursive: true });
    const tar = spawnSync('tar', ['-xzf', path.join(release, hostArchive), '-C', extractDir], { encoding: 'utf8' });
    expect(tar.status, tar.stderr).toBe(0);
  }, 900_000);

  it('reports RESULT: PASS', () => {
    expect(buildOutput).toContain('RESULT: PASS');
  });

  it('creates the host archive, the npm bundle and both installers', () => {
    for (const f of [hostArchive, 'frankentty.cjs', 'install.sh', 'install.ps1', 'SHA256SUMS']) {
      expect(existsSync(path.join(release, f)), f).toBe(true);
    }
  });

  it('writes a SHA256SUMS that matches every file in release/', () => {
    const lines = readFileSync(path.join(release, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) {
      const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      expect(m, line).not.toBeNull();
      const [, hash, name] = m as RegExpExecArray;
      const actual = createHash('sha256').update(readFileSync(path.join(release, name as string))).digest('hex');
      expect(actual, name).toBe(hash);
    }
    expect(lines.map((l) => l.slice(66))).toContain(hostArchive);
  });

  it('packs one executable plus LICENSE', () => {
    const list = spawnSync('tar', ['-tzf', path.join(release, hostArchive)], { encoding: 'utf8' });
    expect(list.stdout.trim().split('\n').sort()).toEqual(['LICENSE', 'frankentty']);
  });

  it('the extracted binary prints the package.json version', () => {
    const r = spawnSync(path.join(extractDir, 'frankentty'), ['--version'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(pkgVersion);
  });

  it('the extracted binary runs a headless bench and prints JSON', () => {
    const r = spawnSync(
      path.join(extractDir, 'frankentty'),
      ['--bench', '--demo', 'testsrc2', '--frames', '10', '--size', '40x12', '--json'],
      { encoding: 'utf8', input: '', timeout: 60_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(() => JSON.parse(r.stdout) as unknown).not.toThrow();
  });
});
