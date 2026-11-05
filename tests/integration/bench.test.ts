import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLD } from '../../src/cli/args.ts';
import type { BenchReport } from '../../src/bench/bench.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const hasTool = (tool: string): boolean => spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0;
const canRun = hasTool('ffmpeg') && hasTool('ffprobe');

/** Runs the real entry point with piped (non-TTY) stdio. */
function runMain(args: string[]) {
  const r = spawnSync(process.execPath, ['src/main.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
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

describe.skipIf(!canRun)('frankentty --bench', () => {
  it('--json prints one parseable object with sane savings and exits 0', () => {
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

  it('--size and --json are rejected without --bench (exit 2)', () => {
    expect(runMain(['--demo', '--size', '80x24']).status).toBe(2);
    expect(runMain(['--demo', '--json']).status).toBe(2);
  });
});
