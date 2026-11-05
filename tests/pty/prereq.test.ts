import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALT_ON } from '../../src/renderer/sequences.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helper = path.join(root, 'tests', 'helpers', 'pty_run.py');

const canRun =
  process.platform !== 'win32' && spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!canRun)('prerequisites in a PTY', () => {
  it('missing ffmpeg and ffprobe exit 1 with an install hint and leave the terminal untouched', () => {
    const spec = {
      cmd: [process.execPath, 'src/main.ts', '--demo'],
      cwd: root,
      cols: 80,
      rows: 24,
      timeout: 15,
      // An empty directory as PATH: node is started by absolute path, FFmpeg cannot be found.
      env: { PATH: path.join(root, 'tests', 'helpers', 'no-such-dir'), TERM: 'xterm-256color' },
      events: [],
    };
    const run = spawnSync('python3', [helper, JSON.stringify(spec)], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { exitCode: number; outputBase64: string; timedOut: boolean };
    const output = Buffer.from(parsed.outputBase64, 'base64').toString('utf8');
    expect(parsed.timedOut).toBe(false);
    expect(parsed.exitCode).toBe(1);
    expect(output).toMatch(/ffmpeg and ffprobe not found on PATH\. Install FFmpeg with: \S/);
    expect(output).not.toContain(ALT_ON);
    expect(output.trimEnd().split('\n')).toHaveLength(1);
  });
});
