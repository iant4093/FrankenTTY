// Compressing encoder (REQ-RENDER-02, -03, -04, -05, -07, -08). Pure: no I/O, no timers.
//
// Turns a CellGrid into bytes, comparing against a screen model of what the terminal shows:
//   - cells that already match the model are skipped (cursor-forward or reprint, whichever is shorter);
//   - a color SGR is emitted only when the color in effect differs by more than the threshold;
//   - fg and bg changes in the same cell share one SGR sequence;
//   - a frame with no changed cell produces no bytes at all.
//
// The model stores the color actually in effect for each cell (the reused one, when a nearby
// color was kept), and every comparison is made against the CURRENT source, so the shown color is
// never farther than the threshold from the source and error does not accumulate across frames.

import type { CellGrid, ColorMapper } from './cells.ts';
import { GLYPH_SPACE, colorDistanceSq } from './cells.ts';
import {
  SGR_RESET_BYTES,
  SYNC_BEGIN_BYTES,
  SYNC_END_BYTES,
  byteDecimalLength,
  decimalLength,
  glyphLength,
  writeBytes,
  writeCursorForward,
  writeCursorPosition,
  writeGlyph,
  writeSgr,
} from './sequences.ts';

export interface FrameStats {
  /** Bytes in the returned buffer (0 for an empty frame). */
  bytes: number;
  /** SGR sequences emitted (a combined fg+bg sequence counts once). */
  sgrEmitted: number;
  /** Cells whose glyph was written, including skip runs that were reprinted. */
  cellsWritten: number;
  /** Cells left alone. `cellsWritten + cellsSkipped` always equals `cols * rows`. */
  cellsSkipped: number;
  /** Absolute (`CSI r;c H`) plus relative (`CSI n C`) cursor moves emitted. */
  cursorMoves: number;
  /** Bytes `serializeNaive` of the half-block serializer would emit for the same grid. */
  naiveBytes: number;
  /** SGR sequences the naive serializer would emit: 2 per cell. */
  naiveSgr: number;
}

/** What the terminal shows, per cell. Colors are mapped values (RGB at depth 24, an index otherwise). */
export interface ScreenModel {
  /** Code point shown, or 0 when unknown. */
  readonly glyph: Uint32Array;
  /** Foreground in effect. Meaningless for space cells. */
  readonly fg: Uint32Array;
  readonly bg: Uint32Array;
}

export interface EncoderOptions {
  cols: number;
  rows: number;
  /** 0-based screen column of the top-left cell. */
  offsetX: number;
  /** 0-based screen row of the top-left cell. */
  offsetY: number;
  mapper: ColorMapper;
}

export interface Encoder {
  /**
   * Encodes `grid` (colors are packed RGB, palette already applied) against the screen model.
   * Returns a view into the encoder's buffer, valid until the next call; length 0 when
   * nothing changed. `thresholdSq` is compared with `colorDistanceSq`.
   */
  encode(grid: CellGrid, thresholdSq: number): Buffer;
  /** Forgets what the terminal shows; the next frame writes every cell. */
  invalidate(): void;
  readonly stats: FrameStats;
  readonly model: ScreenModel;
  /** Size in bytes of the preallocated output buffer. */
  readonly capacity: number;
}

/** Largest row or column number the 12-byte row-move budget covers. */
const MAX_COORDINATE = 9999;

/** Worst case per cell: 3-byte glyph plus a combined 24-bit SGR (`CSI 38;2;…;48;2;… m`, 36 bytes). */
const CELL_BYTES = 39;

const EMPTY_U32 = new Uint32Array(0);

export function createEncoder(options: EncoderOptions): Encoder {
  const { cols, rows, offsetX, offsetY, mapper } = options;
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new RangeError(`cols and rows must be integers >= 1, got ${String(cols)}x${String(rows)}`);
  }
  if (
    !Number.isInteger(offsetX) ||
    !Number.isInteger(offsetY) ||
    offsetX < 0 ||
    offsetY < 0 ||
    offsetX + cols > MAX_COORDINATE ||
    offsetY + rows > MAX_COORDINATE
  ) {
    throw new RangeError(`offsets out of range: ${String(offsetX)},${String(offsetY)} for ${String(cols)}x${String(rows)}`);
  }

  const depth = mapper.depth;
  const is24 = depth === 24;
  const cells = cols * rows;
  const capacity = CELL_BYTES * cells + 12 * rows + 32;
  const buf = Buffer.allocUnsafe(capacity);

  const modelGlyph = new Uint32Array(cells);
  const modelFg = new Uint32Array(cells);
  const modelBg = new Uint32Array(cells);
  const stats: FrameStats = {
    bytes: 0,
    sgrEmitted: 0,
    cellsWritten: 0,
    cellsSkipped: 0,
    cursorMoves: 0,
    naiveBytes: 0,
    naiveSgr: 0,
  };

  // Per-frame state, shared by the helpers below (the encoder is not reentrant).
  let tsq = 0;
  let p = 0;
  /** Mapped colors the terminal is using right now, or -1 when unknown (frame start, after SGR 0). */
  let curFg = -1;
  let curBg = -1;
  let gGlyph: Uint32Array = EMPTY_U32;
  let gFg: Uint32Array = EMPTY_U32;
  let gBg: Uint32Array = EMPTY_U32;

  /** True when mapped colors `a` and `b` look the same within the threshold. */
  function near(a: number, b: number): boolean {
    if (a === b) return true;
    return is24 ? colorDistanceSq(a, b) <= tsq : colorDistanceSq(mapper.toRgb(a), mapper.toRgb(b)) <= tsq;
  }

  /** Writes cell `i` from the grid, emitting at most one SGR, and records what is now shown. */
  function writeCell(i: number): void {
    const glyph = gGlyph[i] ?? GLYPH_SPACE;
    const bg = mapper.map(gBg[i] ?? 0);
    const bgChange = curBg < 0 || !near(curBg, bg);
    const solid = glyph === GLYPH_SPACE;
    let fg = 0;
    let fgChange = false;
    if (!solid) {
      fg = mapper.map(gFg[i] ?? 0);
      fgChange = curFg < 0 || !near(curFg, fg);
    }
    if (fgChange || bgChange) {
      p = writeSgr(buf, p, depth, fgChange ? fg : -1, bgChange ? bg : -1);
      if (fgChange) curFg = fg;
      if (bgChange) curBg = bg;
      stats.sgrEmitted++;
    }
    p = writeGlyph(buf, p, glyph);
    modelGlyph[i] = glyph;
    modelBg[i] = curBg;
    if (!solid) modelFg[i] = curFg;
    stats.cellsWritten++;
  }

  /**
   * Decides whether cells [from, to) are cheaper to reprint than to jump over with a
   * `CSI n C` of `cursorLen` bytes. Reprinting is only considered when no cell needs an SGR
   * under the current state: an SGR costs at least 5 bytes and one of the terminal's scarcest
   * resources, so it never beats the jump. Ties go to reprinting.
   */
  function cheaperToReprint(from: number, to: number, cursorLen: number): boolean {
    let cost = 0;
    for (let j = from; j < to; j++) {
      const glyph = gGlyph[j] ?? GLYPH_SPACE;
      if (curBg < 0 || !near(curBg, mapper.map(gBg[j] ?? 0))) return false;
      if (glyph !== GLYPH_SPACE && (curFg < 0 || !near(curFg, mapper.map(gFg[j] ?? 0)))) return false;
      cost += glyphLength(glyph);
      if (cost > cursorLen) return false;
    }
    return true;
  }

  function countNaive(grid: CellGrid): void {
    // serializeNaive: framing + one CUP per row + (2 RGB SGRs + a 3-byte block) per cell.
    let bytes = SYNC_BEGIN_BYTES.length + SGR_RESET_BYTES.length + SYNC_END_BYTES.length;
    const col = decimalLength(offsetX + 1);
    for (let y = 0; y < rows; y++) bytes += 4 + decimalLength(offsetY + y + 1) + col;
    const { fg, bg } = grid;
    for (let i = 0; i < cells; i++) {
      const f = fg[i] ?? 0;
      const b = bg[i] ?? 0;
      bytes +=
        23 +
        byteDecimalLength((f >>> 16) & 0xff) +
        byteDecimalLength((f >>> 8) & 0xff) +
        byteDecimalLength(f & 0xff) +
        byteDecimalLength((b >>> 16) & 0xff) +
        byteDecimalLength((b >>> 8) & 0xff) +
        byteDecimalLength(b & 0xff);
    }
    stats.naiveBytes = bytes;
    stats.naiveSgr = 2 * cells;
  }

  return {
    capacity,
    stats,
    model: { glyph: modelGlyph, fg: modelFg, bg: modelBg },
    invalidate() {
      modelGlyph.fill(0);
    },
    encode(grid, thresholdSq) {
      if (grid.cols !== cols || grid.rows !== rows) {
        throw new RangeError(
          `grid is ${String(grid.cols)}x${String(grid.rows)}, encoder is ${String(cols)}x${String(rows)}`,
        );
      }
      tsq = thresholdSq;
      gGlyph = grid.glyph;
      gFg = grid.fg;
      gBg = grid.bg;
      stats.bytes = 0;
      stats.sgrEmitted = 0;
      stats.cellsWritten = 0;
      stats.cellsSkipped = 0;
      stats.cursorMoves = 0;
      countNaive(grid);

      p = writeBytes(buf, 0, SYNC_BEGIN_BYTES);
      curFg = -1;
      curBg = -1;
      const col = offsetX + 1;
      for (let y = 0; y < rows; y++) {
        const base = y * cols;
        let cursorKnown = false; // true once something was written on this row
        let pending = 0; // unchanged cells since the last written cell on this row
        for (let x = 0; x < cols; x++) {
          const i = base + x;
          const glyph = gGlyph[i] ?? GLYPH_SPACE;
          const solid = glyph === GLYPH_SPACE;
          const bg = mapper.map(gBg[i] ?? 0);
          let same = modelGlyph[i] === glyph && near(modelBg[i] ?? 0, bg);
          if (same && !solid) same = near(modelFg[i] ?? 0, mapper.map(gFg[i] ?? 0));
          if (same) {
            if (cursorKnown) pending++;
            else stats.cellsSkipped++;
            continue;
          }
          if (!cursorKnown) {
            p = writeCursorPosition(buf, p, offsetY + y + 1, col + x);
            stats.cursorMoves++;
            cursorKnown = true;
          } else if (pending > 0) {
            const jumpLen = 3 + decimalLength(pending);
            if (cheaperToReprint(i - pending, i, jumpLen)) {
              for (let j = i - pending; j < i; j++) writeCell(j);
            } else {
              p = writeCursorForward(buf, p, pending);
              stats.cursorMoves++;
              stats.cellsSkipped += pending;
            }
            pending = 0;
          }
          writeCell(i);
        }
        stats.cellsSkipped += pending; // trailing run: nothing to move over
      }

      if (stats.cellsWritten === 0) {
        stats.bytes = 0;
        return buf.subarray(0, 0);
      }
      p = writeBytes(buf, p, SGR_RESET_BYTES);
      p = writeBytes(buf, p, SYNC_END_BYTES);
      stats.bytes = p;
      return buf.subarray(0, p);
    },
  };
}
