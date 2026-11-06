// Render pipeline (REQ-RENDER-01..08, REQ-PAL-01): decode pixels -> mode builder -> palette -> encoder.
//
// One Pipeline per geometry. Every buffer (cell grid, half-block work area, encoder output and
// screen model) is allocated in createPipeline and reused by every render() call. A geometry change
// means a new pipeline. A mode, palette, threshold or depth change keeps the geometry (the decode
// resolution is always 2c x 4r) and keeps the screen model: it describes what the terminal shows,
// and that did not change, so the next frame writes only the cells that differ. The model is
// refreshed a few rows per frame (`refreshRolling`) to repair any drift.
//
// Pure apart from performance.now(): no I/O, no timers.

import { performance } from 'node:perf_hooks';
import type { Mode, Palette } from '../cli/args.ts';
import { buildAsciiCells } from '../renderer/ascii.ts';
import { buildBrailleCells } from '../renderer/braille.ts';
import { createCellGrid } from '../renderer/cells.ts';
import type { ColorDepth } from '../renderer/cells.ts';
import { createMapper } from '../renderer/color-depth.ts';
import { createEncoder } from '../renderer/encoder.ts';
import type { Encoder, FrameStats } from '../renderer/encoder.ts';
import { buildHalfblockCells } from '../renderer/halfblock-cells.ts';
import { createPalette } from '../renderer/palette.ts';
import type { PaletteMap } from '../renderer/palette.ts';

export interface PipelineOptions {
  /** Render area in cells (`Geometry.renderCols` / `renderRows`). Integers >= 1. */
  cols: number;
  rows: number;
  /** 0-based screen position of the render area's top-left cell. */
  offsetX: number;
  offsetY: number;
  mode: Mode;
  palette: Palette;
  depth: ColorDepth;
  /** Color merge threshold, 0..100, in `sqrt(colorDistanceSq)` units. */
  threshold: number;
}

export interface PipelineStats extends FrameStats {
  /** Milliseconds spent in the last render(): mode builder + palette + encoder. */
  renderMs: number;
}

export interface Pipeline {
  readonly cols: number;
  readonly rows: number;
  /** Decode resolution this pipeline expects: `2 * cols` x `4 * rows` RGB24. */
  readonly decodeWidth: number;
  readonly decodeHeight: number;
  readonly mode: Mode;
  readonly palette: Palette;
  readonly depth: ColorDepth;
  /** Current color merge threshold, 0..100. */
  readonly threshold: number;
  /** Size in bytes of the encoder's output buffer: the largest render() result. */
  readonly outputCapacity: number;
  /**
   * Renders one decoded frame. Returns a view into the encoder buffer, valid until the next
   * call; length 0 when nothing on screen changes. The caller must not write it while an earlier
   * write of the same buffer may still be queued.
   */
  render(decodePixels: Uint8Array): Buffer;
  /** Forgets what the terminal shows; the next render() writes every cell. */
  invalidate(): void;
  /** Forgets what the terminal shows on rows [start, start + count) of the render area. */
  invalidateRows(start: number, count: number): void;
  /**
   * Rolling refresh: marks the next `ceil(rows / 60)` rows unknown (wrapping around), so the next
   * render() rewrites them. Over `ceil(rows / K)` calls every row is marked exactly once. Call it
   * once per presented frame.
   */
  refreshRolling(): void;
  /** Switches the cell builder. Keeps geometry and the screen model. */
  setMode(mode: Mode): void;
  /** Switches the palette. Keeps geometry and the screen model. */
  setPalette(palette: Palette): void;
  /** Changes the color merge threshold. Takes effect on the next render(); the screen model stays valid. */
  setThreshold(threshold: number): void;
  /**
   * Switches the output color depth (new mapper and encoder). Keeps geometry and the screen
   * model, which holds RGB: a cell shown in 24-bit is compared with the new mapper's color in RGB.
   */
  setDepth(depth: ColorDepth): void;
  /** Stats of the last render(). The object is reused: read it before the next call. */
  readonly stats: Readonly<PipelineStats>;
}

/** The whole screen is rewritten about every this many frames (about 2 s at 30 fps). */
export const REFRESH_PERIOD_FRAMES = 60;

/**
 * Applies the capability gates of REQ-CAP-03: without a UTF-8 locale only ASCII is allowed; without
 * Braille support (`TERM=linux`) Braille falls back to half-block.
 */
export function effectiveMode(requested: Mode, unicode: boolean, braille: boolean): Mode {
  if (!unicode) return 'ascii';
  if (requested === 'braille' && !braille) return 'halfblock';
  return requested;
}

export function createPipeline(options: PipelineOptions): Pipeline {
  const { cols, rows, offsetX, offsetY } = options;
  let depth = options.depth;
  let threshold = options.threshold;
  let thresholdSq = threshold * threshold;
  const decodeWidth = 2 * cols;
  const decodeHeight = 4 * rows;

  const grid = createCellGrid(cols, rows);
  // 2x2-averaged pixels for the half-block builder: c x 2r RGB24.
  const work = new Uint8Array(cols * 2 * rows * 3);
  const makeEncoder = (): Encoder => createEncoder({ cols, rows, offsetX, offsetY, mapper: createMapper(depth) });
  let encoder = makeEncoder();
  const outputCapacity = encoder.capacity;
  const refreshRows = Math.ceil(rows / REFRESH_PERIOD_FRAMES);
  let refreshCursor = 0;
  let mode = options.mode;
  let paletteName = options.palette;
  let palette: PaletteMap = createPalette(paletteName);

  const stats: PipelineStats = {
    bytes: 0,
    sgrEmitted: 0,
    cellsWritten: 0,
    cellsSkipped: 0,
    cursorMoves: 0,
    naiveBytes: 0,
    naiveSgr: 0,
    renderMs: 0,
  };

  return {
    cols,
    rows,
    decodeWidth,
    decodeHeight,
    get mode() {
      return mode;
    },
    get palette() {
      return paletteName;
    },
    get depth() {
      return depth;
    },
    get threshold() {
      return threshold;
    },
    outputCapacity,
    stats,
    render(decodePixels) {
      const start = performance.now();
      switch (mode) {
        case 'halfblock':
          buildHalfblockCells(decodePixels, decodeWidth, decodeHeight, grid, work, thresholdSq);
          break;
        case 'braille':
          buildBrailleCells(decodePixels, decodeWidth, decodeHeight, grid);
          break;
        case 'ascii':
          buildAsciiCells(decodePixels, decodeWidth, decodeHeight, grid);
          break;
      }
      palette.applyGrid(grid);
      const bytes = encoder.encode(grid, thresholdSq);
      const encoderStats = encoder.stats;
      stats.bytes = encoderStats.bytes;
      stats.sgrEmitted = encoderStats.sgrEmitted;
      stats.cellsWritten = encoderStats.cellsWritten;
      stats.cellsSkipped = encoderStats.cellsSkipped;
      stats.cursorMoves = encoderStats.cursorMoves;
      stats.naiveBytes = encoderStats.naiveBytes;
      stats.naiveSgr = encoderStats.naiveSgr;
      stats.renderMs = performance.now() - start;
      return bytes;
    },
    invalidate() {
      encoder.invalidate();
    },
    invalidateRows(start, count) {
      encoder.invalidateRows(start, count);
    },
    refreshRolling() {
      const first = Math.min(refreshRows, rows - refreshCursor);
      encoder.invalidateRows(refreshCursor, first);
      if (first < refreshRows) encoder.invalidateRows(0, refreshRows - first);
      refreshCursor = (refreshCursor + refreshRows) % rows;
    },
    setMode(next) {
      mode = next;
    },
    setPalette(next) {
      paletteName = next;
      palette = createPalette(next);
    },
    setThreshold(next) {
      threshold = next;
      thresholdSq = next * next;
    },
    setDepth(next) {
      if (next === depth) return;
      depth = next;
      // The mapper is fixed per encoder. The screen model holds RGB, so it carries over as is.
      const old = encoder;
      encoder = makeEncoder();
      encoder.model.glyph.set(old.model.glyph);
      encoder.model.fg.set(old.model.fg);
      encoder.model.bg.set(old.model.bg);
    },
  };
}
