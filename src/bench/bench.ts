// Headless benchmark (REQ-BENCH-01): decode N frames with the real decoder as fast as possible
// (no pacing), run each through the render pipeline, and report what the compression saved.
// No terminal, no screen, no TTY needed.
//
// JSON report (`--json`): one object on one line. Field names are stable:
//   source            string   demo name or input path/URL
//   frames            number   frames processed (fewer than requested when the media ends first)
//   cols, rows        number   simulated terminal size (the HUD row is reserved, as in playback)
//   renderCols        number   render area in cells after the aspect-ratio fit
//   renderRows        number
//   mode              string   halfblock | ascii | braille
//   palette           string   truecolor | amber | green | dmg
//   depth             string   truecolor | 256 | 16
//   threshold         number   color merge threshold (0-100)
//   naiveKbPerFrame   number   average KB per frame of the naive half-block serializer (1 KB = 1024 bytes)
//   kbPerFrame        number   average KB per frame written by the compressing encoder
//   byteSavingsPct    number   100 * (1 - compressed bytes / naive bytes)
//   naiveSgrPerFrame  number   average SGR sequences per frame, naive (2 per cell)
//   sgrPerFrame       number   average SGR sequences per frame, compressed
//   sgrSavingsPct     number   100 * (1 - compressed SGRs / naive SGRs)
//   cellsSkippedPct   number   100 * cells left alone / cells encoded
//   renderMsP50       number   per-frame render time (builder + palette + encoder), nearest-rank p50
//   renderMsP95       number   p95
//   renderMsMax       number   slowest frame
//   decodeWallMs      number   wall time from starting ffmpeg to the last frame processed
//                              (includes ffmpeg start-up and rendering; no pacing)
// Numbers are rounded to 3 decimals.

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Mode, Palette } from '../cli/args.ts';
import { createDecoder } from '../ingest/decoder.ts';
import type { MediaInfo } from '../ingest/media-info.ts';
import { createPipeline } from '../player/pipeline.ts';
import type { ColorDepth } from '../renderer/cells.ts';
import { computeGeometry } from '../renderer/geometry.ts';

export type DepthLabel = 'truecolor' | '256' | '16';

export interface BenchParams {
  /** Label for the report: demo name or input path/URL. */
  source: string;
  media: MediaInfo;
  /** ffmpeg input arguments, as for the player. */
  inputArgs: string[];
  isFile: boolean;
  /** Frames to process. */
  frames: number;
  /** Simulated terminal size; the bottom row is reserved for the HUD. */
  cols: number;
  rows: number;
  fps: number;
  /** Cell height / width, 1..3. */
  cellAspect: number;
  mode: Mode;
  palette: Palette;
  depth: ColorDepth;
  threshold: number;
}

export interface BenchReport {
  source: string;
  frames: number;
  cols: number;
  rows: number;
  renderCols: number;
  renderRows: number;
  mode: Mode;
  palette: Palette;
  depth: DepthLabel;
  threshold: number;
  naiveKbPerFrame: number;
  kbPerFrame: number;
  byteSavingsPct: number;
  naiveSgrPerFrame: number;
  sgrPerFrame: number;
  sgrSavingsPct: number;
  cellsSkippedPct: number;
  renderMsP50: number;
  renderMsP95: number;
  renderMsMax: number;
  decodeWallMs: number;
}

/** A failure the user can read in one line. */
export class BenchError extends Error {}

const KB = 1024;
const INITIAL_SAMPLES = 4096;

export function depthLabel(depth: ColorDepth): DepthLabel {
  return depth === 24 ? 'truecolor' : depth === 8 ? '256' : '16';
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function savingsPct(naive: number, actual: number): number {
  return naive > 0 ? (1 - actual / naive) * 100 : 0;
}

/** Nearest-rank percentile of the first `n` entries of `sorted` (ascending). */
function percentile(sorted: Float64Array, n: number, p: number): number {
  if (n === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * n));
  return sorted[rank - 1] ?? 0;
}

export function lastLine(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  return lines[lines.length - 1] ?? '';
}

/** Calls `kill` if the process dies mid-run (REQ-TERM-03 applies to child processes too). Returns the remover. */
export function installKillTraps(kill: () => void): () => void {
  const onExit = (): void => {
    kill();
  };
  const onSigint = (): void => {
    kill();
    process.exit(130);
  };
  const onSigterm = (): void => {
    kill();
    process.exit(143);
  };
  process.once('exit', onExit);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return () => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
}

export async function runBench(params: BenchParams): Promise<BenchReport> {
  const { media, frames: wanted } = params;
  const geometry = computeGeometry({
    srcWidth: media.width,
    srcHeight: media.height,
    cols: params.cols,
    rows: params.rows,
    cellAspect: params.cellAspect,
  });
  if (geometry.renderCols === 0 || geometry.renderRows === 0) {
    throw new BenchError(`--size ${String(params.cols)}x${String(params.rows)} leaves no room for video`);
  }
  const cells = geometry.renderCols * geometry.renderRows;

  const pipeline = createPipeline({
    cols: geometry.renderCols,
    rows: geometry.renderRows,
    offsetX: geometry.offsetX,
    offsetY: geometry.offsetY,
    mode: params.mode,
    palette: params.palette,
    depth: params.depth,
    threshold: params.threshold,
  });
  const stats = pipeline.stats;

  let samples = new Float64Array(Math.min(wanted, INITIAL_SAMPLES));
  let naiveBytes = 0;
  let bytes = 0;
  let naiveSgr = 0;
  let sgr = 0;
  let skipped = 0;
  let processed = 0;

  const decoder = createDecoder({
    inputArgs: params.inputArgs,
    width: geometry.decodeWidth,
    height: geometry.decodeHeight,
    fps: params.fps,
    generation: 1,
    isFile: params.isFile,
  });
  const removeTraps = installKillTraps(() => {
    decoder.killNow();
  });
  let ended = false;
  let endDetail = '';
  decoder.onEnd((info) => {
    ended = true;
    endDetail = lastLine(info.stderrTail);
  });

  const started = performance.now();
  let lastFrameAt = started;
  try {
    while (processed < wanted) {
      const frame = decoder.takeOldest();
      if (frame === null) {
        if (ended) break;
        await delay(1);
        continue;
      }
      pipeline.render(frame);
      if (processed === samples.length) {
        const bigger = new Float64Array(Math.min(wanted, samples.length * 2));
        bigger.set(samples);
        samples = bigger;
      }
      samples[processed] = stats.renderMs;
      naiveBytes += stats.naiveBytes;
      bytes += stats.bytes;
      naiveSgr += stats.naiveSgr;
      sgr += stats.sgrEmitted;
      skipped += stats.cellsSkipped;
      processed++;
      lastFrameAt = performance.now();
    }
  } finally {
    removeTraps();
    await decoder.stop();
  }

  if (processed === 0) {
    throw new BenchError(endDetail === '' ? 'no frames were decoded' : `ffmpeg: ${endDetail}`);
  }

  const sorted = samples.slice(0, processed).sort();
  return {
    source: params.source,
    frames: processed,
    cols: params.cols,
    rows: params.rows,
    renderCols: geometry.renderCols,
    renderRows: geometry.renderRows,
    mode: params.mode,
    palette: params.palette,
    depth: depthLabel(params.depth),
    threshold: params.threshold,
    naiveKbPerFrame: round3(naiveBytes / processed / KB),
    kbPerFrame: round3(bytes / processed / KB),
    byteSavingsPct: round3(savingsPct(naiveBytes, bytes)),
    naiveSgrPerFrame: round3(naiveSgr / processed),
    sgrPerFrame: round3(sgr / processed),
    sgrSavingsPct: round3(savingsPct(naiveSgr, sgr)),
    cellsSkippedPct: round3((100 * skipped) / (processed * cells)),
    renderMsP50: round3(percentile(sorted, processed, 50)),
    renderMsP95: round3(percentile(sorted, processed, 95)),
    renderMsMax: round3(sorted[processed - 1] ?? 0),
    decodeWallMs: round3(lastFrameAt - started),
  };
}

/** One JSON object on one line, newline-terminated. */
export function formatBenchJson(report: BenchReport): string {
  return `${JSON.stringify(report)}\n`;
}

function fixed(value: number, digits: number): string {
  return value.toFixed(digits);
}

/** Human-readable table, newline-terminated. */
export function formatBenchText(r: BenchReport): string {
  const rows: [string, string][] = [
    ['source', r.source],
    ['frames', String(r.frames)],
    ['terminal size', `${String(r.cols)}x${String(r.rows)} (render area ${String(r.renderCols)}x${String(r.renderRows)} cells)`],
    ['mode', r.mode],
    ['palette', r.palette],
    ['color depth', r.depth],
    ['threshold', String(r.threshold)],
    ['KB/frame naive', fixed(r.naiveKbPerFrame, 2)],
    ['KB/frame compressed', fixed(r.kbPerFrame, 2)],
    ['byte savings', `${fixed(r.byteSavingsPct, 1)}%`],
    ['SGR/frame naive', fixed(r.naiveSgrPerFrame, 1)],
    ['SGR/frame compressed', fixed(r.sgrPerFrame, 1)],
    ['SGR savings', `${fixed(r.sgrSavingsPct, 1)}%`],
    ['cells skipped', `${fixed(r.cellsSkippedPct, 1)}%`],
    ['render ms p50', fixed(r.renderMsP50, 3)],
    ['render ms p95', fixed(r.renderMsP95, 3)],
    ['render ms max', fixed(r.renderMsMax, 3)],
    ['decode wall time', `${fixed(r.decodeWallMs, 0)} ms`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return `FrankenTTY bench\n${rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n')}\n`;
}
