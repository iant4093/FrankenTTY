import { describe, expect, it } from 'vitest';
import { BRAILLE_BASE, GLYPH_SPACE, createCellGrid } from '../../src/renderer/cells.ts';
import { BRAILLE_DOT_BITS, buildBrailleCells } from '../../src/renderer/braille.ts';

/** Builds a 2x4 block (one cell) of RGB24 from a per-pixel color function. */
function block(colorAt: (x: number, y: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(2 * 4 * 3);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 2; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * 2 + x) * 3;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    }
  }
  return out;
}

const BLACK: [number, number, number] = [0, 0, 0];
const WHITE: [number, number, number] = [255, 255, 255];

describe('[REQ-RENDER-06] buildBrailleCells', () => {
  const expectedBit: Record<string, number> = {
    '0,0': 0x01,
    '0,1': 0x02,
    '0,2': 0x04,
    '1,0': 0x08,
    '1,1': 0x10,
    '1,2': 0x20,
    '0,3': 0x40,
    '1,3': 0x80,
  };

  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 2; x++) {
      it(`a single bright pixel at (${String(x)},${String(y)}) sets the right dot`, () => {
        const grid = createCellGrid(1, 1);
        const px = block((px_, py) => (px_ === x && py === y ? WHITE : BLACK));
        buildBrailleCells(px, 2, 4, grid);
        expect(grid.glyph[0]).toBe(BRAILLE_BASE + (expectedBit[`${String(x)},${String(y)}`] ?? -1));
        expect(grid.fg[0]).toBe(0xffffff);
        expect(grid.bg[0]).toBe(0x000000);
      });
    }
  }

  it('exposes the dot bit table in y*2+x order', () => {
    expect(Array.from(BRAILLE_DOT_BITS)).toEqual([0x01, 0x08, 0x02, 0x10, 0x04, 0x20, 0x40, 0x80]);
  });

  it('draws a checkerboard with half the dots on', () => {
    const grid = createCellGrid(1, 1);
    const px = block((x, y) => ((x + y) % 2 === 0 ? WHITE : BLACK));
    buildBrailleCells(px, 2, 4, grid);
    // ON at (0,0)=0x01, (1,1)=0x10, (0,2)=0x04, (1,3)=0x80.
    expect(grid.glyph[0]).toBe(BRAILLE_BASE + 0x01 + 0x10 + 0x04 + 0x80);
    expect(grid.fg[0]).toBe(0xffffff);
    expect(grid.bg[0]).toBe(0x000000);
  });

  it('uses a space with fg = bg = block mean for a uniform block', () => {
    const grid = createCellGrid(1, 1);
    buildBrailleCells(
      block(() => [10, 20, 30]),
      2,
      4,
      grid,
    );
    expect(grid.glyph[0]).toBe(GLYPH_SPACE);
    expect(grid.fg[0]).toBe(0x0a141e);
    expect(grid.bg[0]).toBe(0x0a141e);
  });

  it('uses a space when rounding leaves no pixel above the mean', () => {
    // Seven pixels at luma 1 (gray 1), one at 0: mean rounds to 1, nothing is strictly above it.
    const grid = createCellGrid(1, 1);
    buildBrailleCells(
      block((x, y) => (x === 0 && y === 0 ? BLACK : [1, 1, 1])),
      2,
      4,
      grid,
    );
    expect(grid.glyph[0]).toBe(GLYPH_SPACE);
    expect(grid.fg[0]).toBe(grid.bg[0]);
  });

  it('averages ON and OFF pixel colors separately, rounding half up', () => {
    // Left column red-ish bright, right column dark. Lumas: left 54*200>>8 = 42, right 0.
    const grid = createCellGrid(1, 1);
    buildBrailleCells(
      block((x, y) => (x === 0 ? [200 + y, 0, 0] : [0, 0, y === 0 ? 1 : 0])),
      2,
      4,
      grid,
    );
    expect(grid.glyph[0]).toBe(BRAILLE_BASE + 0x01 + 0x02 + 0x04 + 0x40);
    // ON reds: 200,201,202,203 -> mean 201.5 -> 202.
    expect(grid.fg[0]).toBe(202 << 16);
    // OFF blues: 1,0,0,0 -> mean 0.25 -> 0.
    expect(grid.bg[0]).toBe(0);
  });

  it('fills every cell of a multi-cell grid from its own block', () => {
    const grid = createCellGrid(2, 2);
    const w = 4;
    const h = 8;
    const px = new Uint8Array(w * h * 3);
    // Light only the top-left pixel of the cell at (1, 1): pixel (2, 4).
    const i = (4 * w + 2) * 3;
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
    buildBrailleCells(px, w, h, grid);
    expect(grid.glyph[3]).toBe(BRAILLE_BASE + 0x01);
    expect(grid.glyph[0]).toBe(GLYPH_SPACE);
    expect(grid.glyph[1]).toBe(GLYPH_SPACE);
    expect(grid.glyph[2]).toBe(GLYPH_SPACE);
  });

  it('throws RangeError for a wrong decode size', () => {
    const grid = createCellGrid(2, 1);
    expect(() => {
      buildBrailleCells(new Uint8Array(4 * 4 * 3), 4, 4, grid);
    }).not.toThrow(); // 2*2 x 4*1 is the right size
    expect(() => {
      buildBrailleCells(new Uint8Array(100), 3, 4, grid);
    }).toThrow(RangeError);
    expect(() => {
      buildBrailleCells(new Uint8Array(100), 4, 8, grid);
    }).toThrow(RangeError);
  });

  it('throws RangeError when the pixel buffer is too short', () => {
    const grid = createCellGrid(2, 1);
    expect(() => {
      buildBrailleCells(new Uint8Array(4 * 4 * 3 - 1), 4, 4, grid);
    }).toThrow(RangeError);
  });
});
