// ASCII cell builder (REQ-RENDER-06, REQ-CAP-03). Pure: no I/O, no timers, no per-call allocation.
//
// Input: RGB24 pixels at (2 * cols) x (4 * rows). Each cell covers a 2x4 pixel block. The cell's
// mean color (rounded per channel) selects a glyph from the ramp by luma; fg = mean color,
// bg = black. Every glyph is below 0x80 so the mode works in non-UTF-8 locales.

import { GLYPH_SPACE, type CellGrid } from './cells.ts';
import { luma } from './luma.ts';

/** Luma ramp, dark to bright. 10 levels. */
export const ASCII_RAMP = ' .:-=+*#%@';

const RAMP_LAST = ASCII_RAMP.length - 1;

/** Ramp code points, built once at module load. */
const RAMP_CODES: Readonly<Uint8Array> = Uint8Array.from(ASCII_RAMP, (ch) => ch.charCodeAt(0));

/** Background for every ASCII cell. */
export const ASCII_BG = 0x000000;

export function buildAsciiCells(pixels: Uint8Array, decodeWidth: number, decodeHeight: number, grid: CellGrid): void {
  const { cols, rows } = grid;
  if (decodeWidth !== 2 * cols || decodeHeight !== 4 * rows) {
    throw new RangeError(
      `ascii decode size must be ${String(2 * cols)}x${String(4 * rows)}, got ${String(decodeWidth)}x${String(decodeHeight)}`,
    );
  }
  if (pixels.length < decodeWidth * decodeHeight * 3) {
    throw new RangeError(
      `pixels is too small: ${String(pixels.length)} < ${String(decodeWidth * decodeHeight * 3)}`,
    );
  }

  const stride = decodeWidth * 3;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const base = cy * 4 * stride + cx * 6;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let dy = 0; dy < 4; dy++) {
        const i = base + dy * stride;
        sumR += (pixels[i] ?? 0) + (pixels[i + 3] ?? 0);
        sumG += (pixels[i + 1] ?? 0) + (pixels[i + 4] ?? 0);
        sumB += (pixels[i + 2] ?? 0) + (pixels[i + 5] ?? 0);
      }
      const r = (sumR + 4) >> 3;
      const g = (sumG + 4) >> 3;
      const b = (sumB + 4) >> 3;
      const y = luma(r, g, b);
      const level = Math.min(RAMP_LAST, (y * 10) >> 8);

      const cell = cy * cols + cx;
      grid.glyph[cell] = RAMP_CODES[level] ?? GLYPH_SPACE;
      grid.fg[cell] = (r << 16) | (g << 8) | b;
      grid.bg[cell] = ASCII_BG;
    }
  }
}
