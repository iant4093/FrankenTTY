// Task 4.8 in a real PTY: `--demo` plays through the seek cache. With a pre-built cache a +30 s seek shows its
// time within 500 ms (a lavfi seek to 30 s of mandelbrot takes about 2 s). Without one, the first seek says the
// cache is being prepared, playback goes on, and the render is gone after quitting.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDemo } from '../../src/ingest/demo.ts';
import { SYNC_BEGIN } from '../../src/renderer/sequences.ts';
import { demoCachePath, ensureDemoCache } from '../../src/ingest/demo-cache.ts';
import { ciBound, hex, hudSeconds, ON_CI, rowText, screenAt, startPty } from '../helpers/pty.ts';

function available(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}

const canRun =
  process.platform !== 'win32' &&
  available('python3', ['--version']) &&
  available('ffmpeg', ['-version']) &&
  available('ffprobe', ['-version']) &&
  available('ffplay', ['-version']);

const COLS = 100;
const ROWS = 30;
const HUD_ROW = ROWS - 1;
const RIGHT = '\x1b[C';
const SHIFT_RIGHT = '\x1b[1;2C';
/** The pre-built cache holds 40 s: enough for a seek from about 2 s to about 32 s. */
const WARM_CACHE_SEC = 40;

describe.skipIf(!canRun)('[REQ-SYNC-05] --demo mandelbrot with the seek cache, in a PTY', () => {
  let warmDir: string;
  let coldDir: string;

  beforeAll(async () => {
    warmDir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-pty-warm-'));
    coldDir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-pty-cold-'));
    await new Promise<void>((resolve, reject) => {
      ensureDemoCache(getDemo('mandelbrot'), {
        dir: warmDir,
        durationSec: WARM_CACHE_SEC,
        onReady: () => resolve(),
        onError: (m) => reject(new Error(m)),
      });
    });
  }, 120_000);

  afterAll(() => {
    rmSync(warmDir, { recursive: true, force: true });
    rmSync(coldDir, { recursive: true, force: true });
  });

  it('with a pre-built cache, Shift+Right shows 30 s later on the HUD within 500 ms', async () => {
    const keyAt = 3.0;
    // 500 ms on a developer machine; a hosted CI runner gets 900 ms (the "+30s" HUD message lasts 1 s after the
    // 120 ms key coalescing, so the window must end before it expires). The measured value is printed below.
    const window = ciBound(0.5, 0.9);
    const pty = startPty({
      args: ['--demo', 'mandelbrot'],
      cols: COLS,
      rows: ROWS,
      timeout: 15,
      env: { FRANKENTTY_CACHE_DIR: warmDir },
      events: [
        { at: keyAt, hex: hex(SHIFT_RIGHT) },
        { at: 6.0, hex: hex('q') },
      ],
    });
    const run = await pty.finished;
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);

    const hudAt = async (t: number): Promise<string> => {
      const term = await screenAt(run, t, COLS, ROWS);
      try {
        return rowText(term, HUD_ROW);
      } finally {
        term.dispose();
      }
    };
    const before = await hudAt(keyAt - 0.1);
    const after = await hudAt(keyAt + window);
    console.info(
      `[4.8 measurement] HUD before: "${before}"; ${String(window)} s after the key: "${after}" (CI=${String(ON_CI)})`,
    );
    expect(hudSeconds(before) ?? Infinity).toBeLessThan(5);
    expect(hudSeconds(after) ?? 0).toBeGreaterThanOrEqual(30);
    expect(after).toContain('+30s');
    expect(after).not.toContain('preparing seek cache');

    // The HUD shows the target as soon as the seek is applied, so also require pictures of the new position:
    // frames stop while the seek barrier waits (a lavfi seek to 30 s of mandelbrot would hold them for ~2 s),
    // and they must be flowing again by the window's end. The window starts after the 120 ms key coalescing.
    const framesInWindow = run.chunks.filter(
      (c) => c.t > keyAt + 0.2 && c.t <= keyAt + window && c.data.toString('latin1').includes(SYNC_BEGIN),
    ).length;
    expect(framesInWindow).toBeGreaterThan(0);
  }, 60_000);

  it('a warm cache is not announced, and nothing is rendered in the background', async () => {
    const pty = startPty({
      args: ['--demo', 'mandelbrot'],
      cols: COLS,
      rows: ROWS,
      timeout: 10,
      env: { FRANKENTTY_CACHE_DIR: warmDir },
      events: [{ at: 4.0, hex: hex('q') }],
    });
    const run = await pty.finished;
    expect(run.exitCode).toBe(0);
    const text = Buffer.concat(run.chunks.map((c) => c.data)).toString('utf8');
    expect(text).not.toContain('seek cache ready');
    expect(existsSync(`${demoCachePath(getDemo('mandelbrot'), { dir: warmDir })}.partial.mkv`)).toBe(false);
  }, 60_000);

  it('without a cache, a seek says it is preparing; playback goes on; quitting leaves no partial render', async () => {
    const keyAt = 1.5;
    const pty = startPty({
      args: ['--demo', 'mandelbrot'],
      cols: COLS,
      rows: ROWS,
      timeout: 20,
      env: { FRANKENTTY_CACHE_DIR: coldDir },
      events: [
        { at: keyAt, hex: hex(RIGHT) },
        { at: 12.0, hex: hex('q') },
      ],
    });
    const run = await pty.finished;
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);

    const term = await screenAt(run, keyAt + 0.6, COLS, ROWS);
    let hud: string;
    try {
      hud = rowText(term, HUD_ROW);
    } finally {
      term.dispose();
    }
    console.info(`[4.8 measurement] cold seek HUD: "${hud}"`);
    expect(hud).toContain('preparing seek cache...');
    expect(hudSeconds(hud) ?? 0).toBeGreaterThanOrEqual(5);

    const finalCache = demoCachePath(getDemo('mandelbrot'), { dir: coldDir });
    const text = Buffer.concat(run.chunks.map((c) => c.data)).toString('utf8');
    if (existsSync(`${finalCache}.ok`)) {
      // The render finished during the run (it takes about 5 s alone): the HUD announced it.
      expect(text).toContain('seek cache ready');
    } else {
      // Still rendering at quit: the render was cancelled and its partial file removed.
      expect(readdirSync(coldDir).filter((f) => f.endsWith('.partial.mkv'))).toEqual([]);
    }
  }, 60_000);
});
