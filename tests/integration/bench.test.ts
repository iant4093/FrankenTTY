import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLD } from '../../src/cli/args.ts';
import type { BenchReport } from '../../src/bench/bench.ts';
import { SEEK_TEST_POSITIONS, formatSeekText, runSeekTest } from '../../src/bench/seek-test.ts';
import type { SeekReport } from '../../src/bench/seek-test.ts';
import { getDemo } from '../../src/ingest/demo.ts';
import { demoMetadata } from '../../src/ingest/demo.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const hasTool = (tool: string): boolean => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0;
const canRun = hasTool('ffmpeg') && hasTool('ffprobe');

/** Runs the real entry point with piped (non-TTY) stdio. */
function runMain(args: string[], env?: Record<string, string>) {
  const r = spawnSync(process.execPath, ['src/main.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function parseReport(stdout: string): BenchReport {
  expect(stdout.endsWith('\n')).toBe(true);
  expect(stdout.trimEnd().split('\n')).toHaveLength(1); // nothing but the JSON object
  return JSON.parse(stdout) as BenchReport;
}

const FIELDS: (keyof BenchReport)[] = [
  'source', 'frames', 'cols', 'rows', 'renderCols', 'renderRows', 'mode', 'palette', 'depth', 'threshold',
  'naiveKbPerFrame', 'kbPerFrame', 'byteSavingsPct', 'naiveSgrPerFrame', 'sgrPerFrame', 'sgrSavingsPct',
  'cellsSkippedPct', 'renderMsP50', 'renderMsP95', 'renderMsMax', 'decodeWallMs',
];

describe.skipIf(!canRun)('[REQ-BENCH-01] frankentty --bench', () => {
  it('[REQ-BENCH-01][REQ-TTY-01] --json prints one parseable object with sane savings and exits 0', () => {
    const r = runMain(['--bench', '--demo', 'testsrc2', '--frames', '30', '--size', '80x24', '--json']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const report = parseReport(r.stdout);

    expect(Object.keys(report).sort()).toEqual([...FIELDS].sort());
    expect(report.source).toBe('testsrc2');
    expect(report.frames).toBe(30);
    expect(report.cols).toBe(80);
    expect(report.rows).toBe(24);
    expect(report.renderCols).toBeLessThanOrEqual(80);
    expect(report.renderRows).toBeLessThanOrEqual(23); // the HUD row is reserved
    expect(report.mode).toBe('halfblock');
    expect(report.palette).toBe('truecolor');
    expect(report.depth).toBe('truecolor');
    expect(report.threshold).toBe(DEFAULT_THRESHOLD);

    for (const key of ['byteSavingsPct', 'sgrSavingsPct', 'cellsSkippedPct'] as const) {
      expect(report[key]).toBeGreaterThanOrEqual(0);
      expect(report[key]).toBeLessThanOrEqual(100);
    }
    expect(report.kbPerFrame).toBeGreaterThan(0);
    expect(report.naiveKbPerFrame).toBeGreaterThanOrEqual(report.kbPerFrame);
    expect(report.naiveSgrPerFrame).toBeGreaterThanOrEqual(report.sgrPerFrame);
    // The naive serializer emits two SGRs for every cell of the render area.
    expect(report.naiveSgrPerFrame).toBe(2 * report.renderCols * report.renderRows);
    expect(report.renderMsP50).toBeLessThanOrEqual(report.renderMsP95);
    expect(report.renderMsP95).toBeLessThanOrEqual(report.renderMsMax);
    expect(report.decodeWallMs).toBeGreaterThan(0);
  });

  it('a text run prints the table and nothing on stderr', () => {
    const r = runMain(['--bench', '--demo', 'testsrc2', '--frames', '30', '--size', '80x24']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('FrankenTTY bench');
    for (const label of ['frames', 'KB/frame naive', 'KB/frame compressed', 'byte savings', 'SGR savings', 'cells skipped', 'render ms p95', 'decode wall time']) {
      expect(r.stdout).toContain(label);
    }
    expect(() => JSON.parse(r.stdout) as unknown).toThrow();
  });

  it('reports the options it ran with (mode, palette, depth, threshold)', () => {
    const r = runMain([
      '--bench', '--demo', 'mandelbrot', '--frames', '12', '--size', '60x20', '--json',
      '--mode', 'braille', '--palette', 'amber', '--color', '256', '--threshold', '8',
    ]);
    expect(r.status).toBe(0);
    const report = parseReport(r.stdout);
    expect(report.mode).toBe('braille');
    expect(report.palette).toBe('amber');
    expect(report.depth).toBe('256');
    expect(report.threshold).toBe(8);
    expect(report.frames).toBe(12);
  });

  it('a higher threshold does not increase the SGRs per frame', () => {
    const run = (threshold: string): BenchReport =>
      parseReport(
        runMain(['--bench', '--demo', 'gradients', '--frames', '20', '--size', '60x20', '--json', '--threshold', threshold]).stdout,
      );
    expect(run('16').sgrPerFrame).toBeLessThanOrEqual(run('0').sgrPerFrame);
  });

  it('works for a file input too', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-bench-'));
    const file = path.join(dir, 'input.mp4');
    try {
      runFileCase(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function runFileCase(file: string): void {
    const make = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=1', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', file],
      { stdio: 'ignore' },
    );
    if (make.status !== 0) return; // no encoder available: the demo runs above cover the pipeline
    const r = runMain(['--bench', file, '--frames', '10', '--size', '40x12', '--json']);
    expect(r.status).toBe(0);
    const report = parseReport(r.stdout);
    expect(report.frames).toBe(10);
    expect(report.source).toBe(file);
  }

  it('stops early when the media is shorter than --frames', () => {
    const r = runMain(['--bench', '--demo', 'life', '--frames', '100000', '--size', '40x12', '--json', '--fps', '60']);
    // The demo lasts 60 s, so 100000 frames at 60 fps are more than it holds.
    expect(r.status).toBe(0);
    const report = parseReport(r.stdout);
    expect(report.frames).toBeGreaterThan(0);
    expect(report.frames).toBeLessThan(100000);
  }, 120_000);

  it('a missing input prints one stderr line, nothing on stdout, and exits 1', () => {
    const r = runMain(['--bench', path.join(root, 'build', 'no-such-file.mp4'), '--json']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('frankentty:');
  });

  it('[REQ-CLI-02] --size and --json are rejected without --bench (exit 2)', () => {
    expect(runMain(['--demo', '--size', '80x24']).status).toBe(2);
    expect(runMain(['--demo', '--json']).status).toBe(2);
  });
});

const SEEK_FIELDS: (keyof SeekReport)[] = [
  'source', 'viaCache', 'cacheWaitMs', 'cols', 'rows', 'renderCols', 'renderRows', 'seeks', 'maxMs',
];
/** A seek must show its first frame within this on a CI machine (the measured value on a laptop is about 40 ms). */
// Process start-up is much slower on Windows runners (467 ms observed for a 1 s seek on windows-latest).
const SEEK_LIMIT_MS = process.platform === 'win32' ? 1000 : process.env['CI'] ? 600 : 300;

describe.skipIf(!canRun)('frankentty --bench --seek-test', () => {
  let cacheDir: string;
  beforeAll(() => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-seektest-'));
  });
  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('--demo testsrc2: builds the cache first, then every seek (1, 15, 30, 45 s) starts in under 300 ms', () => {
    const r = runMain(['--bench', '--seek-test', '--demo', 'testsrc2', '--size', '80x24', '--json'], {
      FRANKENTTY_CACHE_DIR: cacheDir,
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const report = parseReport(r.stdout) as unknown as SeekReport;
    expect(Object.keys(report).sort()).toEqual([...SEEK_FIELDS].sort());
    expect(report.source).toBe('testsrc2');
    expect(report.viaCache).toBe(true);
    expect(report.cacheWaitMs).toBeGreaterThanOrEqual(0);
    expect(report.cols).toBe(80);
    expect(report.rows).toBe(24);
    expect(report.seeks.map((s) => s.atSec)).toEqual([...SEEK_TEST_POSITIONS]);
    for (const s of report.seeks) {
      expect(s.ms).toBeGreaterThan(0);
      expect(s.ms, `seek to ${String(s.atSec)} s`).toBeLessThan(SEEK_LIMIT_MS);
    }
    expect(report.maxMs).toBe(Math.max(...report.seeks.map((s) => s.ms)));
    expect(readdirSync(cacheDir).filter((f) => f.endsWith('.mkv.ok'))).toHaveLength(1);
    console.info(`[4.8 measurement] seek-test testsrc2: ${r.stdout.trim()}`);
  }, 120_000);

  it('a second run finds the cache already built; the text report lists every position and the slowest', () => {
    const r = runMain(['--bench', '--seek-test', '--demo', 'testsrc2', '--size', '80x24'], { FRANKENTTY_CACHE_DIR: cacheDir });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('FrankenTTY seek test');
    for (const at of SEEK_TEST_POSITIONS) expect(r.stdout).toContain(`seek to ${String(at)} s`);
    expect(r.stdout).toContain('slowest');
    const wait = /ready after ([\d.]+) ms/.exec(r.stdout);
    expect(wait).not.toBeNull();
    expect(Number(wait?.[1])).toBeLessThan(1000); // no render: only the check for the marker file
  }, 120_000);

  it('a file input seeks the file itself (positions past its end are skipped)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-seektest-file-'));
    const file = path.join(dir, 'input.mp4');
    try {
      const make = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=3', '-c:v', 'mpeg4', '-g', '15', '-pix_fmt', 'yuv420p', file],
        { stdio: 'ignore' },
      );
      if (make.status !== 0) return; // no encoder available
      const r = runMain(['--bench', '--seek-test', file, '--size', '40x12', '--json']);
      expect(r.status).toBe(0);
      const report = parseReport(r.stdout) as unknown as SeekReport;
      expect(report.viaCache).toBe(false);
      expect(report.cacheWaitMs).toBeNull();
      expect(report.source).toBe(file);
      expect(report.seeks.map((s) => s.atSec)).toEqual([1]); // 15, 30 and 45 s are past the end of a 3 s file
      expect(report.seeks[0]?.ms).toBeLessThan(SEEK_LIMIT_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a media that is too short for every position fails with one stderr line and exit 1', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-seektest-short-'));
    const file = path.join(dir, 'short.mp4');
    try {
      const make = spawnSync(
        'ffmpeg',
        ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=1', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', file],
        { stdio: 'ignore' },
      );
      if (make.status !== 0) return;
      const r = runMain(['--bench', '--seek-test', file, '--json']);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(r.stderr).toContain('--seek-test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runSeekTest with a short cache (tests only) measures the positions it is given', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'frankentty-seektest-short-cache-'));
    try {
      const demo = getDemo('testsrc2');
      const report = await runSeekTest({
        source: 'testsrc2',
        media: demoMetadata(demo),
        inputArgs: [],
        isFile: false,
        demo,
        cacheDir: dir,
        cacheDurationSec: 6,
        positions: [1, 3, 5],
        cols: 40,
        rows: 12,
        fps: 30,
        cellAspect: 2,
      });
      expect(report.seeks.map((s) => s.atSec)).toEqual([1, 3, 5]);
      for (const s of report.seeks) expect(s.ms).toBeLessThan(SEEK_LIMIT_MS);
      expect(formatSeekText(report)).toContain('seek to 5 s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('[REQ-CLI-02] --seek-test without --bench, and with --frames, exit 2', () => {
    expect(runMain(['--demo', '--seek-test']).status).toBe(2);
    expect(runMain(['--demo', '--bench', '--seek-test', '--frames', '5']).status).toBe(2);
  });
});
