import fc from 'fast-check';
import { describe, it } from 'vitest';
import { createCellGrid } from '../../src/renderer/cells.ts';
import { ASCII_RAMP, buildAsciiCells } from '../../src/renderer/ascii.ts';

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
      delta: fc.integer({ min: 0, max: 255 }),
    }),
  );

// P6 (ascii): glyphs come from the ramp, fg stays inside the block, brighter input never picks a darker glyph.
describe('[P6][REQ-RENDER-06] ascii cell builder', () => {
  it('uses ramp glyphs, keeps fg inside the block range, and is monotonic in brightness', () => {
    fc.assert(
      fc.property(cases, ({ cols, rows, pixels, delta }) => {
        const w = cols * 2;
        const h = rows * 4;
        const grid = createCellGrid(cols, rows);
        buildAsciiCells(pixels, w, h, grid);

        const brighter = pixels.map((v) => Math.min(255, v + delta));
        const grid2 = createCellGrid(cols, rows);
        buildAsciiCells(brighter, w, h, grid2);

        const stride = w * 3;
        for (let cy = 0; cy < rows; cy++) {
          for (let cx = 0; cx < cols; cx++) {
            const cell = cy * cols + cx;
            const glyph = grid.glyph[cell] ?? -1;
            const level = ASCII_RAMP.indexOf(String.fromCharCode(glyph));
            if (level < 0) throw new Error(`cell ${String(cell)}: glyph ${String(glyph)} not in ramp`);
            if (grid.bg[cell] !== 0) throw new Error(`cell ${String(cell)}: bg must be black`);

            for (const shift of [16, 8, 0]) {
              const ch = shift / 8;
              let lo = 255;
              let hi = 0;
              for (let dy = 0; dy < 4; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                  const v = pixels[(cy * 4 + dy) * stride + (cx * 2 + dx) * 3 + (2 - ch)] ?? 0;
                  lo = Math.min(lo, v);
                  hi = Math.max(hi, v);
                }
              }
              const v = ((grid.fg[cell] ?? 0) >>> shift) & 0xff;
              if (v < lo || v > hi) throw new Error(`cell ${String(cell)}: fg channel ${String(v)} outside [${String(lo)},${String(hi)}]`);
            }

            const level2 = ASCII_RAMP.indexOf(String.fromCharCode(grid2.glyph[cell] ?? -1));
            if (level2 < level) throw new Error(`cell ${String(cell)}: brightening lowered level ${String(level)} -> ${String(level2)}`);
          }
        }
      }),
      { numRuns: 1000 },
    );
  });
});
