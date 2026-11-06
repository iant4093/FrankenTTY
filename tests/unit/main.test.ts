import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_TEXT, VERSION } from '../../src/cli/args.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Runs the real entry point with piped (non-TTY) stdio. */
function runMain(args: string[]) {
  const r = spawnSync(process.execPath, ['src/main.ts', ...args], { cwd: root, encoding: 'utf8', input: '' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('main (non-TTY)', () => {
  it('[REQ-CLI-01] --help prints the help text and exits 0', () => {
    const r = runMain(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(HELP_TEXT);
  });

  it('[REQ-CLI-01] --version prints the package version and exits 0', () => {
    const r = runMain(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${VERSION}\n`);
  });

  it('[REQ-CLI-02] an unknown flag prints one line to stderr, exits 2 and writes nothing to stdout', () => {
    const r = runMain(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('--bogus');
  });

  it('[REQ-CLI-02] a bad value names the flag and exits 2', () => {
    const r = runMain(['x.mp4', '--mode', 'rgb']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--mode');
    expect(r.stderr).toContain('halfblock|ascii|braille');
  });

  it('[REQ-CLI-02] missing input exits 2', () => {
    expect(runMain([]).status).toBe(2);
  });

  it('[REQ-TTY-01] without a TTY and without --bench, exits 1 and emits no escape sequences', () => {
    const r = runMain(['--demo']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toContain('\x1b');
    expect(r.stderr.trimEnd().split('\n')).toHaveLength(1);
  });
});
