import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_NAMES, getDemo } from '../../src/ingest/demo.ts';
import type { DemoSource } from '../../src/ingest/demo.ts';
import { demoCachePath, ensureDemoCache } from '../../src/ingest/demo-cache.ts';

const hasTool = (tool: string): boolean => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0;
const canRun = hasTool('ffmpeg') && hasTool('ffprobe');

const RENDER_SEC = 6;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-cache-int-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function waitReady(demo: DemoSource, durationSec: number): Promise<{ path: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    ensureDemoCache(demo, {
      dir,
      durationSec,
      onReady: (p) => resolve({ path: p, ms: performance.now() - t0 }),
      onError: (m) => reject(new Error(m)),
    });
  });
}

function probe(file: string): { streams: { codec_name: string; codec_type: string }[]; format: { duration: string } } {
  const run = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type:format=duration', '-of', 'json', file],
    { encoding: 'utf8' },
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!canRun)('demo cache through FFmpeg', () => {
  it('renders h264 + pcm_s16le with the requested duration, and seeks fast', async () => {
    const demo = getDemo('testsrc2');
    const { path: file, ms } = await waitReady(demo, RENDER_SEC);
    expect(file).toBe(demoCachePath(demo, { dir }));
    expect(existsSync(`${file}.ok`)).toBe(true);
    expect(existsSync(`${file}.partial.mkv`)).toBe(false);

    const info = probe(file);
    const codecs = info.streams.map((s) => `${s.codec_type}:${s.codec_name}`).sort();
    expect(codecs).toEqual(['audio:pcm_s16le', 'video:h264']);
    expect(Math.abs(Number(info.format.duration) - RENDER_SEC)).toBeLessThan(0.2);

    // First frame at -ss 4, best of 3 (includes process start-up).
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const run = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-ss', '4', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        { maxBuffer: 16 * 1024 * 1024 },
      );
      const took = performance.now() - t0;
      expect(run.status, run.stderr.toString()).toBe(0);
      expect(run.stdout.length).toBe(640 * 360 * 3);
      best = Math.min(best, took);
    }
    console.log(`demo-cache: ${RENDER_SEC} s render ${ms.toFixed(0)} ms; first frame after -ss 4: ${best.toFixed(0)} ms`);
    expect(best).toBeLessThan(150);
  }, 60_000);

  it('a second call for the same demo while the first renders does not spawn another ffmpeg', async () => {
    const demo = getDemo('testsrc2');
    const first = ensureDemoCache(demo, { dir, durationSec: RENDER_SEC });
    expect(first.pid).toBeTypeOf('number');
    expect(first.entry.ready).toBe(false);

    const ready = new Promise<string>((resolve) => {
      const second = ensureDemoCache(demo, { dir, durationSec: RENDER_SEC, onReady: resolve });
      expect(second.pid).toBeUndefined();
      expect(second.entry.ready).toBe(false);
    });
    expect(await ready).toBe(demoCachePath(demo, { dir }));
    // A finished cache now answers immediately.
    expect(ensureDemoCache(demo, { dir, durationSec: RENDER_SEC }).entry.ready).toBe(true);
  }, 60_000);

  it('cancel() mid-render kills ffmpeg and leaves no partial file', async () => {
    // mandelbrot is the slowest source, so it is still rendering after 400 ms.
    const demo = getDemo('mandelbrot');
    const onReady: string[] = [];
    const run = ensureDemoCache(demo, { dir, onReady: (p) => onReady.push(p) });
    const pid = run.pid;
    expect(pid).toBeTypeOf('number');
    await tick(400);
    expect(alive(pid as number)).toBe(true);
    expect(existsSync(`${demoCachePath(demo, { dir })}.partial.mkv`)).toBe(true);

    run.cancel();
    run.cancel(); // idempotent
    for (let i = 0; i < 40 && alive(pid as number); i++) await tick(50);
    expect(alive(pid as number)).toBe(false);
    await tick(100);
    expect(readdirSync(dir)).toEqual([]);
    expect(onReady).toEqual([]);
  }, 30_000);
});

// Full 60 s builds of all five demos. Opt in with FRANKENTTY_MEASURE_CACHE=1; prints a table.
describe.skipIf(!canRun || process.env['FRANKENTTY_MEASURE_CACHE'] !== '1')('full demo cache builds', () => {
  it.each([...DEMO_NAMES])('%s', async (name) => {
    const demo = getDemo(name);
    const { path: file, ms } = await waitReady(demo, 60);
    const mb = statSync(file).size / (1024 * 1024);
    const info = probe(file);
    console.log(`demo-cache-full ${name}: build ${(ms / 1000).toFixed(1)} s, ${mb.toFixed(2)} MiB, duration ${info.format.duration}`);
    expect(Math.abs(Number(info.format.duration) - 60)).toBeLessThan(0.2);
  }, 300_000);
});
