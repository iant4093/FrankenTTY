// `--bench --seek-test`: how long a seek takes to show its first frame. For each position the real
// decoder is started at `-ss <position>` and the time until its first frame is taken is measured.
// For a demo, the seek cache is built first (and waited for), because lavfi sources cannot seek.
// No terminal needed. This measures the video decoder only; the audio source is cheaper to start.
//
// JSON report (`--json`): one object on one line. Field names are stable:
//   source        string   demo name or input path/URL
//   viaCache      boolean  true when the frames came from the demo seek cache
//   cacheWaitMs   number|null  time spent waiting for the cache (about 0 when it already existed), null without a cache
//   cols, rows    number   simulated terminal size (the HUD row is reserved)
//   renderCols, renderRows  number  render area in cells after the aspect-ratio fit
//   seeks         {atSec, ms}[]  ms from starting the decoder at atSec to its first frame
//   maxMs         number   the slowest seek
// Numbers are rounded to 1 decimal.

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createDecoder } from '../ingest/decoder.ts';
import { ensureDemoCache } from '../ingest/demo-cache.ts';
import type { DemoSource } from '../ingest/demo.ts';
import type { MediaInfo } from '../ingest/media-info.ts';
import { computeGeometry } from '../renderer/geometry.ts';
import { BenchError, installKillTraps, lastLine } from './bench.ts';

/** Seek targets in seconds. */
export const SEEK_TEST_POSITIONS: readonly number[] = [1, 15, 30, 45];
/** A position closer than this to the end of a source with a known duration is skipped. */
const END_MARGIN_SEC = 0.5;
const FIRST_FRAME_TIMEOUT_MS = 10_000;
const CACHE_WAIT_TIMEOUT_MS = 180_000;

export interface SeekTestParams {
  /** Label for the report: demo name or input path/URL. */
  source: string;
  media: MediaInfo;
  /** ffmpeg input arguments of the source (used as is when `demo` is null). */
  inputArgs: string[];
  isFile: boolean;
  /** When set, the demo's seek cache is built first and the seeks run against the cached file. */
  demo: DemoSource | null;
  /** Cache directory (default: the demo cache's own default). */
  cacheDir?: string;
  /** Tests only: render a shorter cache. Pair with a throwaway `cacheDir` and `positions` inside it. */
  cacheDurationSec?: number;
  /** Default `SEEK_TEST_POSITIONS`. */
  positions?: readonly number[];
  cols: number;
  rows: number;
  fps: number;
  cellAspect: number;
}

export interface SeekSample {
  atSec: number;
  ms: number;
}

export interface SeekReport {
  source: string;
  viaCache: boolean;
  cacheWaitMs: number | null;
  cols: number;
  rows: number;
  renderCols: number;
  renderRows: number;
  seeks: SeekSample[];
  maxMs: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Builds (or finds) the demo cache and resolves with its path. Rejects with a BenchError. */
function awaitCache(
  demo: DemoSource,
  dir: string | undefined,
  durationSec: number | undefined,
): Promise<{ path: string; waitMs: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let cancel: () => void = () => undefined;
    let removeTraps: () => void = () => undefined;
    const timer = setTimeout(() => {
      cancel();
      removeTraps();
      reject(new BenchError(`demo cache: not ready after ${String(CACHE_WAIT_TIMEOUT_MS / 1000)} s`));
    }, CACHE_WAIT_TIMEOUT_MS);
    const run = ensureDemoCache(demo, {
      ...(dir === undefined ? {} : { dir }),
      ...(durationSec === undefined ? {} : { durationSec }),
      onReady: (path) => {
        clearTimeout(timer);
        removeTraps();
        resolve({ path, waitMs: performance.now() - t0 });
      },
      onError: (message) => {
        clearTimeout(timer);
        removeTraps();
        reject(new BenchError(`demo cache: ${message.split('\n')[0] ?? message}`));
      },
    });
    cancel = run.cancel;
    removeTraps = installKillTraps(run.cancel);
  });
}

export async function runSeekTest(params: SeekTestParams): Promise<SeekReport> {
  const { media } = params;
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

  let inputArgs = params.inputArgs;
  let cacheWaitMs: number | null = null;
  if (params.demo !== null) {
    const cache = await awaitCache(params.demo, params.cacheDir, params.cacheDurationSec);
    inputArgs = ['-i', cache.path];
    cacheWaitMs = round1(cache.waitMs);
  }

  const limit = media.durationSec === null ? Infinity : media.durationSec - END_MARGIN_SEC;
  const positions = (params.positions ?? SEEK_TEST_POSITIONS).filter((p) => p < limit);
  if (positions.length === 0) throw new BenchError('--seek-test: the media is too short for any seek position');

  const seeks: SeekSample[] = [];
  for (const [i, atSec] of positions.entries()) {
    const decoder = createDecoder({
      inputArgs,
      width: geometry.decodeWidth,
      height: geometry.decodeHeight,
      fps: params.fps,
      startSec: atSec,
      generation: i + 1,
      isFile: params.isFile,
    });
    const removeTraps = installKillTraps(() => {
      decoder.killNow();
    });
    const t0 = performance.now();
    let ended = false;
    let endDetail = '';
    decoder.onEnd((info) => {
      ended = true;
      endDetail = lastLine(info.stderrTail);
    });
    let ms = -1;
    try {
      while (performance.now() - t0 < FIRST_FRAME_TIMEOUT_MS) {
        if (decoder.takeOldest() !== null) {
          ms = performance.now() - t0;
          break;
        }
        if (ended) break;
        await delay(1);
      }
    } finally {
      removeTraps();
      await decoder.stop();
    }
    if (ms < 0) {
      const why = endDetail === '' ? 'no frame arrived' : `ffmpeg: ${endDetail}`;
      throw new BenchError(`--seek-test: no frame at ${String(atSec)} s (${why})`);
    }
    seeks.push({ atSec, ms: round1(ms) });
  }

  return {
    source: params.source,
    viaCache: params.demo !== null,
    cacheWaitMs,
    cols: params.cols,
    rows: params.rows,
    renderCols: geometry.renderCols,
    renderRows: geometry.renderRows,
    seeks,
    maxMs: Math.max(...seeks.map((s) => s.ms)),
  };
}

/** One JSON object on one line, newline-terminated. */
export function formatSeekJson(report: SeekReport): string {
  return `${JSON.stringify(report)}\n`;
}

/** Human-readable table, newline-terminated. */
export function formatSeekText(r: SeekReport): string {
  const how = r.cacheWaitMs === null ? 'input as given' : `seek cache, ready after ${String(r.cacheWaitMs)} ms`;
  const rows: [string, string][] = [
    ['source', `${r.source} (${how})`],
    ['terminal size', `${String(r.cols)}x${String(r.rows)} (render area ${String(r.renderCols)}x${String(r.renderRows)} cells)`],
    ...r.seeks.map((s): [string, string] => [`seek to ${String(s.atSec)} s`, `${s.ms.toFixed(1)} ms`]),
    ['slowest', `${r.maxMs.toFixed(1)} ms`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return `FrankenTTY seek test\n${rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n')}\n`;
}
