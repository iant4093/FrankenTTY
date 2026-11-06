import fc from 'fast-check';
import { describe, it } from 'vitest';
import { BRAILLE_BASE, GLYPH_SPACE, createCellGrid } from '../../src/renderer/cells.ts';
import { BRAILLE_DOT_BITS, buildBrailleCells } from '../../src/renderer/braille.ts';
import { luma } from '../../src/renderer/luma.ts';

const cases = fc
  .record({
    cols: fc.integer({ min: 1, max: 20 }),
    rows: fc.integer({ min: 1, max: 10 }),
  })
  .chain(({ cols, rows }) =>
    fc.record({
      cols: fc.constant(cols),
      rows: fc.constant(rows),
      pixels: fc.uint8Array({ minLength: cols * 2 * rows * 4 * 3, maxLength: cols * 2 * rows * 4 * 3 }),
    }),
  );

interface Px {
  r: number;
  g: number;
  b: number;
  y: number;
}

function blockPixels(pixels: Uint8Array, cols: number, cx: number, cy: number): Px[] {
  const stride = cols * 2 * 3;
  const out: Px[] = [];
  for (let dy = 0; dy < 4; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const i = (cy * 4 + dy) * stride + (cx * 2 + dx) * 3;
      const r = pixels[i] ?? 0;
      const g = pixels[i + 1] ?? 0;
      const b = pixels[i + 2] ?? 0;
      out.push({ r, g, b, y: luma(r, g, b) });
    }
  }
  return out; // index = dy * 2 + dx
}

// P6 (braille): invariants of the 2x4 block -> glyph/fg/bg mapping.
describe('[P6][REQ-RENDER-06] braille cell builder', () => {
  it('keeps glyphs in range, colors inside the block, and splits ON/OFF around the mean luma', () => {
    fc.assert(
      fc.property(cases, ({ cols, rows, pixels }) => {
        const grid = createCellGrid(cols, rows);
        buildBrailleCells(pixels, cols * 2, rows * 4, grid);

        for (let cy = 0; cy < rows; cy++) {
          for (let cx = 0; cx < cols; cx++) {
            const cell = cy * cols + cx;
            const glyph = grid.glyph[cell] ?? -1;
            const fg = grid.fg[cell] ?? 0;
            const bg = grid.bg[cell] ?? 0;
            const px = blockPixels(pixels, cols, cx, cy);

            // (a) glyph range
            if (glyph !== GLYPH_SPACE && !(glyph >= BRAILLE_BASE && glyph <= BRAILLE_BASE + 0xff)) {
              throw new Error(`cell ${String(cell)}: glyph ${glyph.toString(16)} out of range`);
            }

            // (c) fg and bg channels inside the block's per-channel [min, max]
            for (const [shift, pick] of [
              [16, (p: Px) => p.r],
              [8, (p: Px) => p.g],
              [0, (p: Px) => p.b],
            ] as const) {
              const vals = px.map(pick);
              const lo = Math.min(...vals);
              const hi = Math.max(...vals);
              for (const c of [fg, bg]) {
                const v = (c >>> shift) & 0xff;
                if (v < lo || v > hi) throw new Error(`cell ${String(cell)}: channel ${String(v)} outside [${String(lo)},${String(hi)}]`);
              }
            }

            const bits = glyph === GLYPH_SPACE ? 0 : glyph - BRAILLE_BASE;
            if (glyph === GLYPH_SPACE && fg !== bg) {
              throw new Error(`cell ${String(cell)}: space glyph must have fg = bg`);
            }
            if (bits === 0 || bits === 0xff) continue;

            // (d) ON lumas > mean >= OFF lumas, with the mean from the same rounding rule
            const mean = (px.reduce((s, p) => s + p.y, 0) + 4) >> 3;
            for (let k = 0; k < 8; k++) {
              const on = ((BRAILLE_DOT_BITS[k] ?? 0) & bits) !== 0;
              const y = px[k]?.y ?? 0;
              if (on && !(y > mean)) throw new Error(`cell ${String(cell)}: ON pixel ${String(k)} luma ${String(y)} <= mean ${String(mean)}`);
              if (!on && !(y <= mean)) throw new Error(`cell ${String(cell)}: OFF pixel ${String(k)} luma ${String(y)} > mean ${String(mean)}`);
            }

            // (b) fg is not darker than bg when both sets exist
            const fgY = luma((fg >>> 16) & 0xff, (fg >>> 8) & 0xff, fg & 0xff);
            const bgY = luma((bg >>> 16) & 0xff, (bg >>> 8) & 0xff, bg & 0xff);
            if (fgY < bgY) throw new Error(`cell ${String(cell)}: fg luma ${String(fgY)} < bg luma ${String(bgY)}`);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });
});
