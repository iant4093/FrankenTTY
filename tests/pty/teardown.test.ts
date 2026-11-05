import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESTORE_SEQUENCE } from '../../src/renderer/sequences.ts';
import { replay } from '../helpers/emulator.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const helper = path.join(root, 'tests', 'helpers', 'pty_run.py');

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
    env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', COLORTERM: 'truecolor' },
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
  it("'q' shows the placeholder, exits 0 and restores the terminal", async () => {
    const r = runInPty({ hex: '71' });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('FrankenTTY');
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

  it('the placeholder is on the alternate screen while running', async () => {
    const r = runInPty({ hex: '71' });
    const beforeRestore = r.output.slice(0, r.output.length - RESTORE_SEQUENCE.length);
    const state = await replay(beforeRestore, COLS, ROWS);
    expect(state.bufferType).toBe('alternate');
    expect(state.modes[25]).toBe(2); // cursor hidden
    expect(state.modes[7]).toBe(2); // autowrap off
    const text = state.rows.join('\n');
    expect(text).toContain('FrankenTTY');
    expect(text).toContain('color: 24-bit');
    expect(text).toContain(`size: ${COLS}x${ROWS}`);
  });
});
