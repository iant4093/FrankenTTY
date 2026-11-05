// Braille cell builder (REQ-RENDER-06). Pure: no I/O, no timers, no per-call allocation.
//
// Input: RGB24 pixels at (2 * cols) x (4 * rows). Each terminal cell covers a 2x4 pixel block
// and becomes one Braille glyph (U+2800..U+28FF).
//
// Rule: mean = rounded mean luma of the 8 pixels. A dot is ON when its luma is strictly greater
// than mean. fg = rounded per-channel mean of the ON pixels, bg = rounded per-channel mean of the
// OFF pixels. Because mean is rounded, every ON luma > mean >= every OFF luma.
//
// No dot ON (bits == 0): glyph BRAILLE_BASE + 0 draws nothing, so the cell becomes GLYPH_SPACE
// with fg = bg = the rounded per-channel mean of the whole block. This covers a uniform block
// (all lumas equal) and also near-uniform blocks where rounding leaves no luma above the mean.
// bits == 0xFF cannot occur (mean >= min luma).

import { BRAILLE_BASE, GLYPH_SPACE, type CellGrid } from './cells.ts';
import { luma } from './luma.ts';

/**
 * Braille dot bit for the pixel at (x, y) inside a 2x4 block, indexed `y * 2 + x`.
 * Unicode order: (0,0)=0x01 (0,1)=0x02 (0,2)=0x04 (1,0)=0x08 (1,1)=0x10 (1,2)=0x20 (0,3)=0x40 (1,3)=0x80.
 */
export const BRAILLE_DOT_BITS: Readonly<Uint8Array> = Uint8Array.from([0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80]);

/** Scratch for the 8 luma values of the current block. Allocated once at module load. */
const blockLuma = new Int32Array(8);

/** Rounded (half up) integer mean of `sum` over `n >= 1` samples. */
function roundMean(sum: number, n: number): number {
  return ((sum << 1) + n) / (n << 1) | 0;
}

export function buildBrailleCells(
  pixels: Uint8Array,
  decodeWidth: number,
  decodeHeight: number,
  grid: CellGrid,
): void {
  const { cols, rows } = grid;
  if (decodeWidth !== 2 * cols || decodeHeight !== 4 * rows) {
    throw new RangeError(
      `braille decode size must be ${String(2 * cols)}x${String(4 * rows)}, got ${String(decodeWidth)}x${String(decodeHeight)}`,
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

      // Pass 1: lumas and their sum.
      let lumaSum = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const i = base + dy * stride + dx * 3;
          const y = luma(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
          blockLuma[dy * 2 + dx] = y;
          lumaSum += y;
        }
      }
      const mean = (lumaSum + 4) >> 3;

      // Pass 2: classify and accumulate channel sums.
      let bits = 0;
      let onR = 0;
      let onG = 0;
      let onB = 0;
      let offR = 0;
      let offG = 0;
      let offB = 0;
      let onCount = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const k = dy * 2 + dx;
          const i = base + dy * stride + dx * 3;
          const r = pixels[i] ?? 0;
          const g = pixels[i + 1] ?? 0;
          const b = pixels[i + 2] ?? 0;
          if ((blockLuma[k] ?? 0) > mean) {
            bits |= BRAILLE_DOT_BITS[k] ?? 0;
            onR += r;
            onG += g;
            onB += b;
            onCount++;
          } else {
            offR += r;
            offG += g;
            offB += b;
          }
        }
      }

      const cell = cy * cols + cx;
      if (bits === 0) {
        // Nothing lit: whole block is the "off" set.
        const color = (((offR + 4) >> 3) << 16) | (((offG + 4) >> 3) << 8) | ((offB + 4) >> 3);
        grid.glyph[cell] = GLYPH_SPACE;
        grid.fg[cell] = color;
        grid.bg[cell] = color;
        continue;
      }
      const offCount = 8 - onCount;
      grid.glyph[cell] = BRAILLE_BASE + bits;
      grid.fg[cell] = (roundMean(onR, onCount) << 16) | (roundMean(onG, onCount) << 8) | roundMean(onB, onCount);
      grid.bg[cell] = (roundMean(offR, offCount) << 16) | (roundMean(offG, offCount) << 8) | roundMean(offB, offCount);
    }
  }
}
