// Half-block cell builder (REQ-RENDER-01, -03). Pure: no I/O, no timers, no allocation.

import type { CellGrid } from './cells.ts';
import { GLYPH_SPACE, GLYPH_UPPER_HALF, colorDistanceSq, packRgb } from './cells.ts';
import { downsampleHalfblock } from './downsample.ts';

/**
 * Fills `grid` from decode-resolution pixels (`decodeWidth x decodeHeight`, 2c x 4r RGB24).
 *
 * The pixels are averaged 2x2 into `work` (c x 2r, at least `c*2r*3` bytes), then each cell
 * takes the top pixel as foreground and the bottom pixel as background. When the two are
 * within `thresholdSq` (redmean squared distance), the cell becomes a space with the bottom
 * pixel as background; its foreground is kept but ignored by the encoder.
 */
export function buildHalfblockCells(
  decodePixels: Uint8Array,
  decodeWidth: number,
  decodeHeight: number,
  grid: CellGrid,
  work: Uint8Array,
  thresholdSq: number,
): void {
  const { cols, rows } = grid;
  if (decodeWidth !== cols * 2 || decodeHeight !== rows * 4) {
    throw new RangeError(
      `decode size ${String(decodeWidth)}x${String(decodeHeight)} does not match grid ${String(cols)}x${String(rows)} (need ${String(cols * 2)}x${String(rows * 4)})`,
    );
  }
  downsampleHalfblock(decodePixels, decodeWidth, decodeHeight, work);

  const bottomOffset = cols * 3;
  let top = 0;
  let i = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const bottom = top + bottomOffset;
      const t = packRgb(work[top] ?? 0, work[top + 1] ?? 0, work[top + 2] ?? 0);
      const b = packRgb(work[bottom] ?? 0, work[bottom + 1] ?? 0, work[bottom + 2] ?? 0);
      grid.fg[i] = t;
      grid.bg[i] = b;
      grid.glyph[i] = colorDistanceSq(t, b) <= thresholdSq ? GLYPH_SPACE : GLYPH_UPPER_HALF;
      i++;
      top += 3;
    }
    top += bottomOffset; // skip the bottom pixel row of this cell row
  }
}
