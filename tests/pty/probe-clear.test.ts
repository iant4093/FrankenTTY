// Task 4.12, B2: Apple Terminal 488 does not implement DECRQM (`CSI ?2026$p`) and prints the final byte "p"
// at the cursor. The probe runs on the alternate screen, and a letterboxed frame never paints row 1, so the
// "p" stayed visible. The process now (1) skips the DECRQM query when TERM_PROGRAM=Apple_Terminal and
// (2) clears the screen after the probe, always.
//
// The PTY here is not Apple Terminal: the test plays the terminal's part by rewriting the bytes the process
// wrote, replacing the DECRQM query with the "p" such a terminal prints, and then replays the result into a
// real emulator core (@xterm/headless).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLEAR, PROBE_DECRQM_2026, RESTORE_SEQUENCE } from '../../src/renderer/sequences.ts';
import { hex, rowText, startPty } from '../helpers/pty.ts';
import type { PtyRun } from '../helpers/pty.ts';
import { replayInto } from '../helpers/emulator.ts';

function available(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

const canRun =
  process.platform !== 'win32' &&
  available('python3', ['--version']) &&
  available('ffmpeg', ['-version']) &&
  available('ffprobe', ['-version']);

/** Narrow and tall: a 16:9 picture leaves many empty rows above it, so row 1 is never painted by a frame. */
const COLS = 60;
const ROWS = 40;
const EMPTY_TOP_ROWS = 8;

function makeVideo(file: string): void {
  const input = 'testsrc2=size=320x180:rate=30:duration=4';
  for (const codec of ['libx264', 'mpeg4']) {
    const r = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', input, '-c:v', codec, '-pix_fmt', 'yuv420p', file],
      { stdio: 'ignore' },
    );
    if (r.status === 0) return;
  }
  throw new Error('ffmpeg could not encode the test video');
}

function output(run: PtyRun): Buffer {
  return Buffer.concat(run.chunks.map((c) => c.data));
}

describe.skipIf(!canRun)('[REQ-CAP-02] capability probe on a terminal that prints a stray "p" for DECRQM', () => {
  let dir = '';
  let video = '';

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-probe-clear-'));
    video = path.join(dir, 'testsrc.mp4');
    makeVideo(video);
  }, 60_000);

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('shows no stray "p" on the final screen: the screen is cleared after the probe', async () => {
    const pty = startPty({
      args: [video],
      cols: COLS,
      rows: ROWS,
      timeout: 20,
      events: [{ at: 2.0, hex: hex('q') }],
      env: { TERM_PROGRAM: 'ghostty' }, // a terminal for which the DECRQM query is sent
    });
    const run = await pty.finished;
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);

    const raw = output(run);
    const text = raw.toString('latin1');
    const queryAt = text.indexOf(PROBE_DECRQM_2026);
    expect(queryAt).toBeGreaterThanOrEqual(0);
    // The screen is cleared again after the probe, before the first frame.
    const clearAfter = text.indexOf(CLEAR, queryAt);
    expect(clearAfter).toBeGreaterThan(queryAt);
    expect(clearAfter).toBeLessThan(text.indexOf('\x1b[?2026h', queryAt));

    // Apple Terminal swallows the CSI introducer and prints the "p" instead of the whole query.
    const printed = Buffer.from(text.replace(PROBE_DECRQM_2026, 'p'), 'latin1');
    const term = await replayInto(printed.subarray(0, printed.length - RESTORE_SEQUENCE.length), COLS, ROWS);
    try {
      expect(term.buffer.active.type).toBe('alternate');
      for (let y = 0; y < EMPTY_TOP_ROWS; y++) expect(rowText(term, y)).toBe('');
    } finally {
      term.dispose();
    }

    // Control: without the clear after the probe, the "p" is on row 1.
    const beforeClear = Buffer.from(text.slice(0, clearAfter).replace(PROBE_DECRQM_2026, 'p'), 'latin1');
    const stray = await replayInto(beforeClear, COLS, ROWS);
    try {
      expect(rowText(stray, 0)).toBe('p');
    } finally {
      stray.dispose();
    }
  });

  it('Apple Terminal: the DECRQM query is not sent, the other queries are, and nothing stray is printed', async () => {
    const pty = startPty({
      args: [video],
      cols: COLS,
      rows: ROWS,
      timeout: 20,
      events: [{ at: 2.0, hex: hex('q') }],
      env: { TERM_PROGRAM: 'Apple_Terminal' },
    });
    const run = await pty.finished;
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);

    const text = output(run).toString('latin1');
    expect(text).not.toContain(PROBE_DECRQM_2026);
    expect(text).not.toContain('$p');
    expect(text).toContain('\x1b[16t\x1b[14t\x1b[c');

    const term = await replayInto(text.slice(0, text.length - RESTORE_SEQUENCE.length), COLS, ROWS);
    try {
      for (let y = 0; y < EMPTY_TOP_ROWS; y++) expect(rowText(term, y)).toBe('');
    } finally {
      term.dispose();
    }
  });
});
