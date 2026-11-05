import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ASCII_RAMP } from '../../src/renderer/ascii.ts';
import { AMBER_RAMP } from '../../src/renderer/palette.ts';
import { ALT_ON, RESTORE_SEQUENCE, SYNC_BEGIN } from '../../src/renderer/sequences.ts';
import { readCell, replayInto } from '../helpers/emulator.ts';

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

type PtyEvent = { at: number; hex: string } | { at: number; signal: string } | { at: number; resize: [number, number] };

interface PtyResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  elapsedSec: number;
  /** Time (seconds since spawn) at which each SYNC_BEGIN was read. */
  frameTimes: number[];
}

interface RawResult {
  exitCode: number;
  outputBase64: string;
  timedOut: boolean;
  chunks: { t: number; b64: string }[];
}

function runInPty(args: string[], opts: { cols?: number; rows?: number; timeout: number; events: PtyEvent[] }): PtyResult {
  const spec = {
    cmd: [process.execPath, 'src/main.ts', ...args],
    cwd: root,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    timeout: opts.timeout,
    env: { TERM: 'xterm-256color', LANG: 'en_US.UTF-8', COLORTERM: 'truecolor' },
    events: opts.events,
  };
  const startedAt = Date.now();
  const run = spawnSync('python3', [helper, JSON.stringify(spec)], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const elapsedSec = (Date.now() - startedAt) / 1000;
  if (run.status !== 0) throw new Error(`pty_run.py failed: ${run.stderr}`);
  const raw = JSON.parse(run.stdout) as RawResult;

  // Map every SYNC_BEGIN to the chunk it started in, so frames can be windowed by time.
  const output = Buffer.from(raw.outputBase64, 'base64');
  const needle = Buffer.from(SYNC_BEGIN);
  const frameTimes: number[] = [];
  let chunkIndex = 0;
  let chunkEnd = Buffer.from(raw.chunks[0]?.b64 ?? '', 'base64').length;
  for (let at = output.indexOf(needle); at !== -1; at = output.indexOf(needle, at + 1)) {
    while (at >= chunkEnd && chunkIndex < raw.chunks.length - 1) {
      chunkIndex++;
      chunkEnd += Buffer.from(raw.chunks[chunkIndex]?.b64 ?? '', 'base64').length;
    }
    frameTimes.push(raw.chunks[chunkIndex]?.t ?? 0);
  }
  return { exitCode: raw.exitCode, output: output.toString('utf8'), timedOut: raw.timedOut, elapsedSec, frameTimes };
}

function beforeRestore(output: string): string {
  return output.slice(0, output.length - RESTORE_SEQUENCE.length);
}

function makeVideo(file: string, seconds: number): void {
  const input = `color=c=0xff0000:size=320x180:rate=30:duration=${String(seconds)}`;
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

/** A moving test pattern. A static source writes one frame and then nothing (the encoder skips unchanged frames). */
function makeMovingVideo(file: string, seconds: number): void {
  const input = `testsrc2=size=320x180:rate=30:duration=${String(seconds)}`;
  for (const codec of ['libx264', 'mpeg4']) {
    const r = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', input, '-c:v', codec, '-pix_fmt', 'yuv420p', file],
      { stdio: 'ignore' },
    );
    if (r.status === 0) return;
  }
  throw new Error('ffmpeg could not encode the moving test video');
}

describe.skipIf(!canRun)('playback in a PTY', () => {
  let dir = '';
  let red3 = '';
  let red5 = '';
  let red2 = '';
  let moving5 = '';
  let moving2 = '';

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-playback-'));
    red3 = path.join(dir, 'red3.mp4');
    red5 = path.join(dir, 'red5.mp4');
    red2 = path.join(dir, 'red2.mp4');
    makeVideo(red3, 3);
    makeVideo(red5, 5);
    makeVideo(red2, 2);
    moving5 = path.join(dir, 'moving5.mp4');
    moving2 = path.join(dir, 'moving2.mp4');
    makeMovingVideo(moving5, 5);
    makeMovingVideo(moving2, 2);
  });

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('plays a red file, draws it centered, leaves the HUD row blank and restores on q', async () => {
    const r = runInPty([red3], { timeout: 15, events: [{ at: 1.5, hex: '71' }] });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.output.endsWith(RESTORE_SEQUENCE)).toBe(true);

    const term = await replayInto(beforeRestore(r.output), 80, 24);
    try {
      expect(term.buffer.active.type).toBe('alternate');
      // A solid color is drawn as a space with only a background change (REQ-RENDER-03).
      const center = readCell(term, 40, 11);
      expect(center.char === ' ' || center.char === '').toBe(true);
      expect(center.bg).not.toBeNull();
      const c = center.bg ?? 0;
      expect(Math.abs((c >> 16) - 255)).toBeLessThanOrEqual(16);
      expect(Math.abs(((c >> 8) & 255) - 0)).toBeLessThanOrEqual(16);
      expect(Math.abs((c & 255) - 0)).toBeLessThanOrEqual(16);
      expect(term.buffer.active.getLine(23)?.translateToString(true)).toBe('');
    } finally {
      term.dispose();
    }

    const restored = await replayInto(r.output, 80, 24);
    try {
      expect(restored.buffer.active.type).toBe('normal');
    } finally {
      restored.dispose();
    }
  });

  it('paces a 30 fps source at about 30 frames per second', () => {
    // A moving source: every frame differs, so every frame is written. A static one would be skipped.
    const r = runInPty([moving5], { timeout: 15, events: [{ at: 3.8, hex: '71' }] });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    const first = r.frameTimes[0];
    expect(first).toBeDefined();
    const t0 = first ?? 0;
    // Frames in the 2.0 s after the first frame was read.
    const count = r.frameTimes.filter((t) => t < t0 + 2.0).length;
    console.log(
      `pacing: first frame at ${t0.toFixed(2)} s, ${String(count)} frames in the next 2.0 s ` +
        `(${String(r.frameTimes.length)} total)`,
    );
    expect(count).toBeGreaterThanOrEqual(52);
    expect(count).toBeLessThanOrEqual(68);
  });

  it('exits 0 by itself at the end of a 2 s file and restores the terminal', async () => {
    const r = runInPty([moving2], { timeout: 4, events: [] });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.elapsedSec).toBeLessThan(4.5);
    expect(r.frameTimes.length).toBeGreaterThan(20);
    expect(r.output.endsWith(RESTORE_SEQUENCE)).toBe(true);
    const state = await replayInto(r.output, 80, 24);
    try {
      expect(state.buffer.active.type).toBe('normal');
    } finally {
      state.dispose();
    }
  });

  it('redraws for the new geometry after a resize', async () => {
    const r = runInPty([red5], {
      cols: 80,
      rows: 24,
      timeout: 15,
      events: [
        { at: 1.2, resize: [100, 30] },
        { at: 2.4, hex: '71' },
      ],
    });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.output.endsWith(RESTORE_SEQUENCE)).toBe(true);

    const body = beforeRestore(r.output);
    const clear = '\x1b[2J\x1b[H';
    expect(body.split(clear).length - 1).toBeGreaterThanOrEqual(2); // enter + resize
    const afterResize = body.slice(body.lastIndexOf(clear) + clear.length);
    const rows = [...afterResize.matchAll(/\x1b\[(\d+);\d+H/g)].map((m) => Number(m[1]));
    expect(rows.length).toBeGreaterThan(0);
    expect(Math.max(...rows)).toBeGreaterThan(24);
    expect(Math.max(...rows)).toBeLessThanOrEqual(29);

    const term = await replayInto(body, 100, 30);
    try {
      const center = readCell(term, 50, 14);
      expect(center.char === ' ' || center.char === '').toBe(true);
      expect(Math.abs(((center.bg ?? 0) >> 16) - 255)).toBeLessThanOrEqual(16);
      expect(term.buffer.active.getLine(29)?.translateToString(true)).toBe('');
    } finally {
      term.dispose();
    }
  });

  it('prints one line and exits 1 for an unreadable input, without touching the terminal', () => {
    const r = runInPty([path.join(dir, 'no-such-file.mp4')], { timeout: 15, events: [] });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.output).not.toContain(ALT_ON);
    expect(r.output).not.toContain('\x1b');
    expect(r.output.trimEnd().split('\n')).toHaveLength(1);
    expect(r.output).toContain('frankentty:');
  });

  it('plays --demo mandelbrot and quits cleanly with q', async () => {
    const r = runInPty(['--demo', 'mandelbrot'], { timeout: 15, events: [{ at: 2.0, hex: '71' }] });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.frameTimes.length).toBeGreaterThan(5);
    expect(r.output.endsWith(RESTORE_SEQUENCE)).toBe(true);
    const state = await replayInto(r.output, 80, 24);
    try {
      expect(state.buffer.active.type).toBe('normal');
    } finally {
      state.dispose();
    }
  });

  describe('modes and palettes (--demo mandelbrot, 1 s)', () => {
    async function playOneSecond(extra: string[]) {
      const r = runInPty(['--demo', 'mandelbrot', ...extra], { timeout: 15, events: [{ at: 1.6, hex: '71' }] });
      expect(r.timedOut).toBe(false);
      expect(r.exitCode).toBe(0);
      expect(r.frameTimes.length).toBeGreaterThan(5);
      expect(r.output.endsWith(RESTORE_SEQUENCE)).toBe(true);
      return replayInto(beforeRestore(r.output), 80, 24);
    }

    it('--mode braille draws only Braille glyphs or spaces, and some dots', async () => {
      const term = await playOneSecond(['--mode', 'braille']);
      try {
        let dots = 0;
        let cells = 0;
        for (let y = 0; y < 23; y++) {
          for (let x = 0; x < 80; x++) {
            const ch = readCell(term, x, y).char;
            const cp = ch === '' ? 0x20 : (ch.codePointAt(0) ?? 0);
            expect(cp === 0x20 || (cp >= 0x2800 && cp <= 0x28ff)).toBe(true);
            if (cp > 0x2800) dots++;
            if (readCell(term, x, y).bg !== null) cells++;
          }
        }
        expect(cells).toBeGreaterThan(80 * 15);
        expect(dots).toBeGreaterThan(0);
        expect(term.buffer.active.getLine(23)?.translateToString(true)).toBe('');
      } finally {
        term.dispose();
      }
    });

    it('--mode ascii draws only characters of the luma ramp, and some of them', async () => {
      const term = await playOneSecond(['--mode', 'ascii']);
      try {
        let inked = 0;
        for (let y = 0; y < 23; y++) {
          for (let x = 0; x < 80; x++) {
            const ch = readCell(term, x, y).char;
            expect(ch === '' || ASCII_RAMP.includes(ch)).toBe(true);
            if (ch !== '' && ch !== ' ') inked++;
          }
        }
        expect(inked).toBeGreaterThan(0);
        expect(term.buffer.active.getLine(23)?.translateToString(true)).toBe('');
      } finally {
        term.dispose();
      }
    });

    it('--palette amber paints every colored cell with an amber ramp entry', async () => {
      const term = await playOneSecond(['--palette', 'amber']);
      try {
        let colored = 0;
        let halfBlocks = 0;
        for (let y = 0; y < 23; y++) {
          for (let x = 0; x < 80; x++) {
            const c = readCell(term, x, y);
            if (c.bg !== null) {
              colored++;
              expect(AMBER_RAMP).toContain(c.bg);
            }
            if (c.char === '\u2580') {
              halfBlocks++;
              expect(AMBER_RAMP).toContain(c.fg);
            }
          }
        }
        expect(colored).toBeGreaterThan(80 * 15);
        expect(halfBlocks).toBeGreaterThan(0);
      } finally {
        term.dispose();
      }
    });
  });
});
