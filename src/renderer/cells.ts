// Shared cell-grid types for Wave 3 (owned by architect-opus so parallel tasks 3.1-3.3 share one definition).
//
// Pipeline: decode pixels (2c x 4r RGB24) -> mode builder (half-block | braille | ascii) -> CellGrid
//           -> palette (in place on fg/bg) -> encoder (screen model, RLE, delta, color depth) -> bytes.

/** One terminal cell per index `y * cols + x`. Colors are packed 0xRRGGBB. */
export interface CellGrid {
  readonly cols: number;
  readonly rows: number;
  /** Unicode code point drawn in the cell. */
  readonly glyph: Uint32Array;
  /** Foreground color, packed 0xRRGGBB. */
  readonly fg: Uint32Array;
  /** Background color, packed 0xRRGGBB. */
  readonly bg: Uint32Array;
}

export const GLYPH_SPACE = 0x20;
export const GLYPH_UPPER_HALF = 0x2580;
export const BRAILLE_BASE = 0x2800;

export function createCellGrid(cols: number, rows: number): CellGrid {
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new RangeError(`cell grid must be at least 1x1 integers, got ${String(cols)}x${String(rows)}`);
  }
  const n = cols * rows;
  return { cols, rows, glyph: new Uint32Array(n).fill(GLYPH_SPACE), fg: new Uint32Array(n), bg: new Uint32Array(n) };
}

export function packRgb(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

export function red(c: number): number {
  return (c >>> 16) & 0xff;
}

export function green(c: number): number {
  return (c >>> 8) & 0xff;
}

export function blue(c: number): number {
  return c & 0xff;
}

/**
 * Integer "redmean" weighted squared RGB distance. 0 for equal colors; about 584,970 for
 * black vs white. `--threshold N` (0..100) compares against N * N, so N is a distance in
 * the same units as sqrt(colorDistanceSq). N = 0 is lossless.
 */
export function colorDistanceSq(a: number, b: number): number {
  const r1 = (a >>> 16) & 0xff;
  const r2 = (b >>> 16) & 0xff;
  const dr = r1 - r2;
  const dg = ((a >>> 8) & 0xff) - ((b >>> 8) & 0xff);
  const db = (a & 0xff) - (b & 0xff);
  const rmean = (r1 + r2) >> 1;
  return (((512 + rmean) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rmean) * db * db) >> 8);
}

/** Color depth of the terminal output: 24-bit RGB, 256-color (8-bit) or 16-color (4-bit). */
export type ColorDepth = 24 | 8 | 4;

/**
 * Maps a packed RGB color to what the encoder emits:
 * - depth 24: returns the packed RGB unchanged (emit `38;2;R;G;B`).
 * - depth 8:  returns an xterm 256-color index 16..255 (emit `38;5;n`).
 * - depth 4:  returns an ANSI color index 0..15 (emit 30-37 / 90-97, 40-47 / 100-107).
 * `toRgb` returns the RGB the terminal shows for a mapped value (used for screen-model
 * comparisons and tests).
 */
export interface ColorMapper {
  readonly depth: ColorDepth;
  map(rgb: number): number;
  toRgb(mapped: number): number;
}
