import { describe, expect, it } from 'vitest';
import { GLYPH_SPACE, GLYPH_UPPER_HALF, createCellGrid, packRgb } from '../../src/renderer/cells.ts';
import { buildHalfblockCells } from '../../src/renderer/halfblock-cells.ts';

describe('buildHalfblockCells', () => {
  it('takes the top pixel as foreground and the bottom pixel as background', () => {
    // 2 cols x 1 row of cells = 4 x 4 decode pixels; every 2x2 block is flat.
    const w = 4;
    const h = 4;
    const px = new Uint8Array(w * h * 3);
    const paint = (x0: number, y0: number, r: number, g: number, b: number): void => {
      for (let y = y0; y < y0 + 2; y++) {
        for (let x = x0; x < x0 + 2; x++) px.set([r, g, b], (y * w + x) * 3);
      }
    };
    paint(0, 0, 200, 0, 0); // cell 0 top
    paint(0, 2, 0, 0, 200); // cell 0 bottom
    paint(2, 0, 10, 10, 10); // cell 1 top
    paint(2, 2, 10, 10, 10); // cell 1 bottom
    const grid = createCellGrid(2, 1);
    buildHalfblockCells(px, w, h, grid, new Uint8Array(2 * 2 * 3), 0);
    expect(Array.from(grid.glyph)).toEqual([GLYPH_UPPER_HALF, GLYPH_SPACE]);
    expect(grid.fg[0]).toBe(packRgb(200, 0, 0));
    expect(grid.bg[0]).toBe(packRgb(0, 0, 200));
    expect(grid.bg[1]).toBe(packRgb(10, 10, 10));
    expect(grid.fg[1]).toBe(packRgb(10, 10, 10));
  });

  it('makes a space when top and bottom are within the threshold, a block otherwise', () => {
    const w = 2;
    const h = 4;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < 6; i++) px[i] = 100; // top 2x2 block row 0
    for (let i = 6; i < 12; i++) px[i] = 100;
    for (let i = 12; i < 24; i++) px[i] = 104; // bottom 2x2 block, 4 per channel
    const grid = createCellGrid(1, 1);
    const work = new Uint8Array(1 * 2 * 3);
    // colorDistanceSq((100,100,100), (104,104,104)) = 38 + 64 + 41 = 143.
    buildHalfblockCells(px, w, h, grid, work, 142);
    expect(grid.glyph[0]).toBe(GLYPH_UPPER_HALF);
    buildHalfblockCells(px, w, h, grid, work, 143);
    expect(grid.glyph[0]).toBe(GLYPH_SPACE);
    expect(grid.bg[0]).toBe(packRgb(104, 104, 104));
    expect(grid.fg[0]).toBe(packRgb(100, 100, 100));
  });

  it('rejects a decode size that does not match the grid', () => {
    const grid = createCellGrid(2, 1);
    expect(() => buildHalfblockCells(new Uint8Array(4 * 8 * 3), 4, 8, grid, new Uint8Array(12), 0)).toThrow(RangeError);
  });
});
