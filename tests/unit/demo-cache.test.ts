import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDemo, DEMO_NAMES } from '../../src/ingest/demo.ts';
import { CACHE_VERSION, demoCachePath, ensureDemoCache, renderArgs } from '../../src/ingest/demo-cache.ts';

const MISSING_FFMPEG = 'frankentty-test-no-such-ffmpeg';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-cache-unit-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('demoCachePath', () => {
  it('is stable and named <name>-<16 hex>.mkv in the given dir', () => {
    const demo = getDemo('testsrc2');
    const a = demoCachePath(demo, { dir });
    expect(demoCachePath(demo, { dir })).toBe(a);
    expect(path.dirname(a)).toBe(dir);
    expect(path.basename(a)).toMatch(/^testsrc2-[0-9a-f]{16}\.mkv$/);
  });

  it('defaults to <tmpdir>/frankentty-cache', () => {
    const p = demoCachePath(getDemo('life'));
    expect(path.dirname(p)).toBe(path.join(os.tmpdir(), 'frankentty-cache'));
  });

  it('differs per demo', () => {
    const paths = new Set(DEMO_NAMES.map((n) => demoCachePath(getDemo(n), { dir })));
    expect(paths.size).toBe(DEMO_NAMES.length);
  });

  it('changes when the video filter or the audio filter changes', () => {
    const demo = getDemo('testsrc2');
    const base = demoCachePath(demo, { dir });
    expect(demoCachePath({ ...demo, videoFilter: `${demo.videoFilter},hue=h=1` }, { dir })).not.toBe(base);
    expect(demoCachePath({ ...demo, audioFilter: `${demo.audioFilter}x` }, { dir })).not.toBe(base);
  });

  it('exposes CACHE_VERSION 1', () => {
    expect(CACHE_VERSION).toBe(1);
  });
});

describe('renderArgs', () => {
  it('uses an argv array with short GOP, yuv420p and pcm audio, and ends with the output', () => {
    const args = renderArgs(getDemo('life'), 'out.mkv', 60);
    expect(args.at(-1)).toBe('out.mkv');
    expect(args).toContain('libx264');
    expect(args).toContain('pcm_s16le');
    expect(args[args.indexOf('-g') + 1]).toBe('15');
    expect(args[args.indexOf('-keyint_min') + 1]).toBe('15');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args[args.indexOf('-t') + 1]).toBe('60');
  });
});

describe('ensureDemoCache with an existing cache', () => {
  it('is ready immediately when file and marker exist, and calls onReady on the next tick', async () => {
    const demo = getDemo('testsrc2');
    const file = demoCachePath(demo, { dir });
    writeFileSync(file, 'x');
    writeFileSync(`${file}.ok`, '1');
    const ready: string[] = [];
    const run = ensureDemoCache(demo, { dir, ffmpegPath: MISSING_FFMPEG, onReady: (p) => ready.push(p) });
    expect(run.entry).toEqual({ path: file, ready: true });
    expect(run.pid).toBeUndefined();
    expect(ready).toEqual([]);
    await tick(0);
    expect(ready).toEqual([file]);
    run.cancel();
    expect(existsSync(file)).toBe(true); // cancel never deletes a finished cache
  });

  it('does not call onReady after cancel()', async () => {
    const demo = getDemo('testsrc2');
    const file = demoCachePath(demo, { dir });
    writeFileSync(file, 'x');
    writeFileSync(`${file}.ok`, '1');
    let calls = 0;
    const run = ensureDemoCache(demo, { dir, onReady: () => calls++ });
    run.cancel();
    await tick(10);
    expect(calls).toBe(0);
  });
});

describe('ensureDemoCache rebuilds', () => {
  it('rebuilds when the marker is missing (reports the failed spawn, cleans the partial)', async () => {
    const demo = getDemo('testsrc2');
    const file = demoCachePath(demo, { dir });
    writeFileSync(file, 'x');
    const errors: string[] = [];
    let ready = 0;
    const run = ensureDemoCache(demo, {
      dir,
      ffmpegPath: MISSING_FFMPEG,
      onReady: () => ready++,
      onError: (m) => errors.push(m),
    });
    expect(run.entry.ready).toBe(false);
    await tick(200);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Demo cache render failed');
    expect(ready).toBe(0);
    expect(run.entry.ready).toBe(false);
    expect(existsSync(`${file}.partial.mkv`)).toBe(false);
  });

  it('rebuilds when the file is empty even if the marker exists', async () => {
    const demo = getDemo('testsrc2');
    const file = demoCachePath(demo, { dir });
    writeFileSync(file, '');
    writeFileSync(`${file}.ok`, '1');
    const errors: string[] = [];
    const run = ensureDemoCache(demo, { dir, ffmpegPath: MISSING_FFMPEG, onError: (m) => errors.push(m) });
    expect(run.entry.ready).toBe(false);
    await tick(200);
    expect(errors).toHaveLength(1);
  });

  it('calls onError once even though the failure is reported by two events', async () => {
    const errors: string[] = [];
    ensureDemoCache(getDemo('life'), { dir, ffmpegPath: MISSING_FFMPEG, onError: (m) => errors.push(m) });
    await tick(300);
    expect(errors).toHaveLength(1);
  });

  it('takes over a stale partial (older than 60 s) instead of waiting', async () => {
    const demo = getDemo('testsrc2');
    const partial = `${demoCachePath(demo, { dir })}.partial.mkv`;
    writeFileSync(partial, 'stale');
    const old = new Date(Date.now() - 120_000);
    utimesSync(partial, old, old);
    const errors: string[] = [];
    ensureDemoCache(demo, { dir, ffmpegPath: MISSING_FFMPEG, onError: (m) => errors.push(m) });
    await tick(200);
    expect(errors).toHaveLength(1); // it tried to render (and failed on the missing binary)
  });

  it('reports an unusable cache directory through onError', async () => {
    const blocker = path.join(dir, 'file');
    writeFileSync(blocker, 'x');
    const errors: string[] = [];
    const run = ensureDemoCache(getDemo('life'), { dir: path.join(blocker, 'sub'), onError: (m) => errors.push(m) });
    expect(run.pid).toBeUndefined();
    await tick(20);
    expect(errors).toHaveLength(1);
  });
});

describe('ensureDemoCache while another process renders', () => {
  it('does not spawn, then reports ready once the final file and marker appear', async () => {
    const demo = getDemo('testsrc2');
    const file = demoCachePath(demo, { dir });
    writeFileSync(`${file}.partial.mkv`, 'in progress');
    const ready: string[] = [];
    const errors: string[] = [];
    const run = ensureDemoCache(demo, {
      dir,
      ffmpegPath: MISSING_FFMPEG, // would produce an error if a spawn was attempted
      onReady: (p) => ready.push(p),
      onError: (m) => errors.push(m),
    });
    expect(run.pid).toBeUndefined();
    expect(run.entry.ready).toBe(false);
    await tick(700);
    expect(errors).toEqual([]);
    expect(ready).toEqual([]);

    writeFileSync(file, 'done');
    writeFileSync(`${file}.ok`, '1');
    await tick(1200);
    expect(ready).toEqual([file]);
    expect(run.entry.ready).toBe(true);
    expect(existsSync(`${file}.partial.mkv`)).toBe(true); // not ours: left alone
  });

  it('cancel() stops polling and leaves the other process partial alone', async () => {
    const demo = getDemo('testsrc2');
    const file = demoCachePath(demo, { dir });
    const partial = `${file}.partial.mkv`;
    writeFileSync(partial, 'in progress');
    let ready = 0;
    const run = ensureDemoCache(demo, { dir, onReady: () => ready++ });
    run.cancel();
    run.cancel();
    writeFileSync(file, 'done');
    writeFileSync(`${file}.ok`, '1');
    await tick(1100);
    expect(ready).toBe(0);
    expect(existsSync(partial)).toBe(true);
  });
});
