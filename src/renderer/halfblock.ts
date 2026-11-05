// Half-block serializer (REQ-RENDER-01, -04, -07). Pure: no I/O, no timers.
//
// This is the NAIVE baseline: every cell is written in full, with both colors and no deltas.
// Later waves add run-length and delta encoding on top. The naive path stays as the
// reference for `--bench`.

import {
  SGR_BG_RGB_PREFIX,
  SGR_FG_RGB_PREFIX,
  SGR_RESET_BYTES,
  SYNC_BEGIN_BYTES,
  SYNC_END_BYTES,
  UPPER_HALF_BLOCK_BYTES,
  writeBytes,
  writeCursorPosition,
  writeSgrRgb,
} from './sequences.ts';

export interface HalfblockSerializer {
  /**
   * Serializes `pixels` (c x 2r RGB24) with the top-left cell at 0-based
   * (`offsetX`, `offsetY`). Returns a view into the serializer's own buffer, valid
   * until the next call. Does not allocate except for the returned view.
   */
  serializeNaive(pixels: Uint8Array, offsetX: number, offsetY: number): Buffer;
  /** Size in bytes of the preallocated output buffer. */
  readonly capacity: number;
}

/** Largest row or column number the 12-byte row-move budget covers. */
const MAX_COORDINATE = 9999;

/** Worst case per cell: two 19-byte SGRs plus the 3-byte block glyph. */
const CELL_BYTES = 41;

export function createHalfblockSerializer(cols: number, rows: number): HalfblockSerializer {
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new RangeError(`cols and rows must be integers >= 1, got ${String(cols)}x${String(rows)}`);
  }
  const capacity = CELL_BYTES * cols * rows + 12 * rows + 64;
  const buf = Buffer.allocUnsafe(capacity);
  const rowStride = cols * 3;
  const pixelBytes = cols * rows * 2 * 3;

  return {
    capacity,
    serializeNaive(pixels, offsetX, offsetY) {
      if (pixels.length < pixelBytes) {
        throw new RangeError(`pixels is too small: ${String(pixels.length)} < ${String(pixelBytes)}`);
      }
      if (
        !Number.isInteger(offsetX) ||
        !Number.isInteger(offsetY) ||
        offsetX < 0 ||
        offsetY < 0 ||
        offsetX + 1 > MAX_COORDINATE ||
        offsetY + rows > MAX_COORDINATE
      ) {
        throw new RangeError(`offsets out of range: ${String(offsetX)},${String(offsetY)}`);
      }

      let p = writeBytes(buf, 0, SYNC_BEGIN_BYTES);
      const col = offsetX + 1;
      for (let y = 0; y < rows; y++) {
        p = writeCursorPosition(buf, p, offsetY + y + 1, col);
        let top = y * 2 * rowStride;
        let bottom = top + rowStride;
        for (let x = 0; x < cols; x++) {
          p = writeSgrRgb(buf, p, SGR_FG_RGB_PREFIX, pixels[top] ?? 0, pixels[top + 1] ?? 0, pixels[top + 2] ?? 0);
          p = writeSgrRgb(
            buf,
            p,
            SGR_BG_RGB_PREFIX,
            pixels[bottom] ?? 0,
            pixels[bottom + 1] ?? 0,
            pixels[bottom + 2] ?? 0,
          );
          buf[p++] = UPPER_HALF_BLOCK_BYTES[0] ?? 0;
          buf[p++] = UPPER_HALF_BLOCK_BYTES[1] ?? 0;
          buf[p++] = UPPER_HALF_BLOCK_BYTES[2] ?? 0;
          top += 3;
          bottom += 3;
        }
      }
      p = writeBytes(buf, p, SGR_RESET_BYTES);
      p = writeBytes(buf, p, SYNC_END_BYTES);
      return buf.subarray(0, p);
    },
  };
}
