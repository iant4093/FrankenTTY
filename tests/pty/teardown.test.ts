import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESTORE_SEQUENCE, SYNC_BEGIN } from '../../src/renderer/sequences.ts';
import { replay } from '../helpers/emulator.ts';
import { buildDemoCaches, makeCacheDir } from '../helpers/pty.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helper = path.join(root, 'tests', 'helpers', 'pty_run.py');
/** Set by the suite's beforeAll: a finished seek cache of the default demo, so no background render runs. */
let cacheDir = '';

function available(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

const canRun =
  process.platform !== 'win32' &&
  available('python3', ['--version']) &&
  available('ffmpeg', ['-version']) &&
  available('ffprobe', ['-version']);

const COLS = 80;
const ROWS = 24;
// Node start-up plus the 200 ms probe timeout (no emulator answers in the PTY)
// must be over before input arrives.
const INPUT_AT = 1.0;

interface PtyResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

function runInPty(event: { hex: string } | { signal: string }): PtyResult {
  const spec = {
    cmd: [process.execPath, 'src/main.ts', '--demo'],
    cwd: root,
    cols: COLS,
    rows: ROWS,
    timeout: 15,
    env: {
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      COLORTERM: 'truecolor',
      SDL_AUDIODRIVER: 'dummy',
      FRANKENTTY_CACHE_DIR: cacheDir,
    },
    events: [{ at: INPUT_AT, ...event }],
  };
  const run = spawnSync('python3', [helper, JSON.stringify(spec)], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`pty_run.py failed: ${run.stderr}`);
  const parsed = JSON.parse(run.stdout) as { exitCode: number; outputBase64: string; timedOut: boolean };
  return {
    exitCode: parsed.exitCode,
    output: Buffer.from(parsed.outputBase64, 'base64').toString('utf8'),
    timedOut: parsed.timedOut,
  };
}

async function expectCleanTerminal(output: string): Promise<void> {
  expect(output.endsWith(RESTORE_SEQUENCE)).toBe(true);
  const state = await replay(output, COLS, ROWS);
  expect(state.bufferType).toBe('normal');
  expect(state.modes[25]).toBe(1); // cursor visible
  expect(state.modes[7]).toBe(1); // autowrap on
  expect(state.modes[2026]).not.toBe(1); // synchronized output off
}

describe.skipIf(!canRun)('terminal teardown in a PTY', () => {
  beforeAll(async () => {
    cacheDir = makeCacheDir('teardown');
    await buildDemoCaches(cacheDir, ['mandelbrot']);
  }, 180_000);

  afterAll(() => {
    if (cacheDir !== '') rmSync(cacheDir, { recursive: true, force: true });
  });
  it("'q' exits 0 and restores the terminal", async () => {
    const r = runInPty({ hex: '71' });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    await expectCleanTerminal(r.output);
  });

  it('byte 0x03 exits 130 and restores the terminal', async () => {
    const r = runInPty({ hex: '03' });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(130);
    await expectCleanTerminal(r.output);
  });

  it('SIGTERM exits 143 and restores the terminal', async () => {
    const r = runInPty({ signal: 'SIGTERM' });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(143);
    await expectCleanTerminal(r.output);
  });

  it('playback runs on the alternate screen with the cursor hidden and autowrap off', async () => {
    const r = runInPty({ hex: '71' });
    expect(r.output).toContain(SYNC_BEGIN);
    const beforeRestore = r.output.slice(0, r.output.length - RESTORE_SEQUENCE.length);
    const state = await replay(beforeRestore, COLS, ROWS);
    expect(state.bufferType).toBe('alternate');
    expect(state.modes[25]).toBe(2); // cursor hidden
    expect(state.modes[7]).toBe(2); // autowrap off
    expect(state.rows[ROWS - 1]).toMatch(/^\u25b6 /); // the bottom row holds the HUD
  });
});
