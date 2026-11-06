import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const installSh = path.join(root, 'scripts', 'install.sh');

const osName = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : '';
const archName = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : '';
const supported = osName !== '' && archName !== '';
const archiveName = `frankentty-${osName}-${archName}.tar.gz`;

const STUB = '#!/bin/sh\necho "frankentty stub 0.0.0"\n';

let work = '';
let releaseDir = '';

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function writeSums(dir: string, files: string[]): void {
  const lines = files.map((f) => `${sha256(path.join(dir, f))}  ${f}\n`);
  writeFileSync(path.join(dir, 'SHA256SUMS'), lines.join(''));
}

/** A release directory shaped like release/ from build-release.sh, with a stub binary. */
function makeRelease(dir: string): void {
  const stage = path.join(dir, 'stage');
  mkdirSync(stage, { recursive: true });
  writeFileSync(path.join(stage, 'frankentty'), STUB);
  chmodSync(path.join(stage, 'frankentty'), 0o755);
  writeFileSync(path.join(stage, 'LICENSE'), 'MIT stub\n');
  const tar = spawnSync('tar', ['-czf', path.join(dir, archiveName), '-C', stage, 'frankentty', 'LICENSE'], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  expect(tar.status).toBe(0);
  rmSync(stage, { recursive: true, force: true });
  copyFileSync(installSh, path.join(dir, 'install.sh'));
  writeSums(dir, [archiveName, 'install.sh']);
}

interface RunOptions {
  args?: string[];
  base?: string;
  installDir: string;
  home: string;
  env?: Record<string, string>;
  pathVar?: string;
  detached?: boolean;
}

function runInstaller(o: RunOptions) {
  const env: Record<string, string> = {
    PATH: o.pathVar ?? process.env.PATH ?? '',
    HOME: o.home,
    SHELL: '/bin/zsh',
    TMPDIR: work,
    FRANKENTTY_RELEASE_BASE: o.base ?? pathToFileURL(releaseDir).href,
    FRANKENTTY_INSTALL_DIR: o.installDir,
    ...o.env,
  };
  // detached = setsid, so the child has no controlling terminal and /dev/tty cannot be opened.
  // Node honors `detached` in spawnSync but @types/node does not declare it.
  const options = {
    cwd: work,
    env,
    encoding: 'utf8',
    input: '',
    detached: o.detached ?? false,
  } as SpawnSyncOptionsWithStringEncoding;
  return spawnSync('sh', [installSh, ...(o.args ?? ['--no-ffmpeg'])], options);
}

function freshDirs(name: string): { home: string; installDir: string } {
  const home = path.join(work, name);
  mkdirSync(home, { recursive: true });
  return { home, installDir: path.join(home, 'bin') };
}

/** A PATH directory holding only the tools install.sh uses, so ffmpeg is reliably absent. */
function makeToolsDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const names = [
    'uname', 'tar', 'mktemp', 'mkdir', 'cp', 'chmod', 'mv', 'rm', 'awk', 'basename', 'id', 'cat',
    'sed', 'tr', 'sha256sum', 'shasum', 'sysctl', 'gzip', 'dirname', 'head', 'sh', 'perl',
  ];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const n of names) {
    for (const d of dirs) {
      const p = path.join(d, n);
      if (existsSync(p)) {
        symlinkSync(p, path.join(dir, n));
        break;
      }
    }
  }
  return dir;
}

describe.skipIf(process.platform === 'win32' || !supported)('install.sh', () => {
  beforeAll(() => {
    work = mkdtempSync(path.join(tmpdir(), 'frankentty-install-test-'));
    releaseDir = path.join(work, 'release');
    mkdirSync(releaseDir);
    makeRelease(releaseDir);
  });

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('passes shellcheck in sh mode when shellcheck is installed', (ctx) => {
    const probe = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) ctx.skip();
    const r = spawnSync('shellcheck', ['-s', 'sh', installSh], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('installs an executable binary, verifies the checksum and prints the PATH hint', () => {
    const { home, installDir } = freshDirs('happy');
    const r = runInstaller({ home, installDir });
    expect(r.status, r.stderr).toBe(0);

    const bin = path.join(installDir, 'frankentty');
    expect(existsSync(bin)).toBe(true);
    expect(() => accessSync(bin, constants.X_OK)).not.toThrow();
    const run = spawnSync(bin, [], { encoding: 'utf8' });
    expect(run.stdout).toContain('frankentty stub');

    expect(r.stdout).toContain('Checksum verified.');
    expect(r.stdout).toContain(`${installDir} is not on your PATH`);
    expect(r.stdout).toContain(`export PATH="${installDir}:$PATH"`);
    expect(r.stdout).toContain('~/.zshrc');
    expect(r.stdout).toContain('Uninstall: rm');
    expect(r.stdout).toContain('Run: frankentty --demo');
    // No leftover staging file or temp dir contents next to the binary.
    expect(readdirSync(installDir)).toEqual(['frankentty']);
  });

  it('prints fish and bash hints for those shells and never edits rc files', () => {
    const fish = freshDirs('fish');
    const rf = runInstaller({ ...fish, env: { SHELL: '/usr/bin/fish' } });
    expect(rf.status, rf.stderr).toBe(0);
    expect(rf.stdout).toContain(`fish_add_path ${fish.installDir}`);

    const bash = freshDirs('bash');
    const rb = runInstaller({ ...bash, env: { SHELL: '/bin/bash' } });
    expect(rb.status, rb.stderr).toBe(0);
    expect(rb.stdout).toContain('~/.bashrc');

    for (const d of [fish, bash]) {
      expect(readdirSync(d.home).sort()).toEqual(['bin']);
    }
  });

  it('prints no PATH hint when the install dir is already on PATH', () => {
    const { home, installDir } = freshDirs('onpath');
    const r = runInstaller({ home, installDir, pathVar: `${installDir}${path.delimiter}${process.env.PATH ?? ''}` });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('is not on your PATH');
  });

  it('defaults to $HOME/.local/bin when FRANKENTTY_INSTALL_DIR is unset', () => {
    const { home } = freshDirs('default-dir');
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      SHELL: '/bin/zsh',
      TMPDIR: work,
      FRANKENTTY_RELEASE_BASE: pathToFileURL(releaseDir).href,
    };
    const r = spawnSync('sh', [installSh, '--no-ffmpeg'], { cwd: work, env, encoding: 'utf8', input: '' });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(path.join(home, '.local', 'bin', 'frankentty'))).toBe(true);
  });

  it('replaces an existing install', () => {
    const { home, installDir } = freshDirs('upgrade');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(installDir, 'frankentty'), '#!/bin/sh\necho old\n');
    const r = runInstaller({ home, installDir });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(installDir, 'frankentty'), 'utf8')).toBe(STUB);
  });

  it('exits 1 and installs nothing when the archive is corrupt', () => {
    const bad = path.join(work, 'release-corrupt');
    mkdirSync(bad);
    makeRelease(bad);
    const archive = path.join(bad, archiveName);
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('tampered')]));
    const { home, installDir } = freshDirs('corrupt');
    const r = runInstaller({ home, installDir, base: pathToFileURL(bad).href });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('checksum mismatch');
    expect(existsSync(installDir)).toBe(false);
  });

  it('exits 1 when SHA256SUMS has no entry for the archive', () => {
    const bad = path.join(work, 'release-nosum');
    mkdirSync(bad);
    makeRelease(bad);
    writeSums(bad, ['install.sh']);
    const { home, installDir } = freshDirs('nosum');
    const r = runInstaller({ home, installDir, base: pathToFileURL(bad).href });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no entry');
    expect(existsSync(installDir)).toBe(false);
  });

  it('exits 1 when the archive cannot be fetched', () => {
    const { home, installDir } = freshDirs('missing');
    const r = runInstaller({ home, installDir, base: pathToFileURL(path.join(work, 'nowhere')).href });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('frankentty install:');
    expect(existsSync(installDir)).toBe(false);
  });

  it('exits 1 with a clear message on an unsupported architecture (FRANKENTTY_UNAME_M, test only)', () => {
    const { home, installDir } = freshDirs('arch');
    const r = runInstaller({ home, installDir, env: { FRANKENTTY_UNAME_M: 'armv7l' } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unsupported CPU architecture: armv7l');
    expect(existsSync(installDir)).toBe(false);
  });

  it('rejects an unknown option and shows --help', () => {
    const { home, installDir } = freshDirs('opts');
    const bad = runInstaller({ home, installDir, args: ['--bogus'] });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('unknown option: --bogus');
    const help = runInstaller({ home, installDir, args: ['--help'] });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--no-ffmpeg');
    expect(existsSync(installDir)).toBe(false);
  });

  describe('FFmpeg handling', () => {
    it('reports FFmpeg as found when all three tools are on PATH', () => {
      const tools = makeToolsDir(path.join(work, 'tools-found'));
      for (const t of ['ffmpeg', 'ffprobe', 'ffplay']) {
        writeFileSync(path.join(tools, t), '#!/bin/sh\nexit 0\n');
        chmodSync(path.join(tools, t), 0o755);
      }
      const { home, installDir } = freshDirs('ff-found');
      const r = runInstaller({ home, installDir, args: [], pathVar: tools, detached: true });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('FFmpeg found');
    });

    it('prints the install command and continues when there is no TTY and no --yes', () => {
      const tools = makeToolsDir(path.join(work, 'tools-notty'));
      const marker = path.join(work, 'brew-notty-ran');
      writeFileSync(path.join(tools, 'brew'), `#!/bin/sh\necho ran > "${marker}"\n`);
      chmodSync(path.join(tools, 'brew'), 0o755);
      const { home, installDir } = freshDirs('ff-notty');
      const r = runInstaller({ home, installDir, args: [], pathVar: tools, detached: true });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('FrankenTTY needs FFmpeg. Missing: ffmpeg ffprobe ffplay');
      expect(r.stdout).toMatch(/Install command: .*ffmpeg/);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(path.join(installDir, 'frankentty'))).toBe(true);
    });

    it('--yes runs the package manager command without asking', () => {
      const tools = makeToolsDir(path.join(work, 'tools-yes'));
      const marker = path.join(work, 'brew-yes-ran');
      // Linux hosts try apt-get first, so stub every manager; macOS only considers brew.
      for (const pm of ['brew', 'apt-get', 'dnf', 'pacman', 'zypper', 'sudo']) {
        writeFileSync(path.join(tools, pm), `#!/bin/sh\necho "${pm} $*" >> "${marker}"\n`);
        chmodSync(path.join(tools, pm), 0o755);
      }
      const { home, installDir } = freshDirs('ff-yes');
      const r = runInstaller({ home, installDir, args: ['--yes'], pathVar: tools, detached: true });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain('[y/N]');
      expect(readFileSync(marker, 'utf8')).toMatch(/install.* ffmpeg/);
    });

    it('--no-ffmpeg never touches the package manager', () => {
      const tools = makeToolsDir(path.join(work, 'tools-no'));
      const marker = path.join(work, 'brew-no-ran');
      for (const pm of ['brew', 'apt-get', 'dnf', 'pacman', 'zypper', 'sudo']) {
        writeFileSync(path.join(tools, pm), `#!/bin/sh\necho ran >> "${marker}"\n`);
        chmodSync(path.join(tools, pm), 0o755);
      }
      const { home, installDir } = freshDirs('ff-no');
      const r = runInstaller({ home, installDir, args: ['--yes', '--no-ffmpeg'], pathVar: tools, detached: true });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toContain('FFmpeg');
      expect(existsSync(marker)).toBe(false);
    });
  });
});
