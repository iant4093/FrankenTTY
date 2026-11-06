import { describe, expect, it } from 'vitest';
import { createCellGrid } from '../../src/renderer/cells.ts';
import { ASCII_RAMP, buildAsciiCells } from '../../src/renderer/ascii.ts';

function solid(cols: number, rows: number, r: number, g: number, b: number): Uint8Array {
  const px = new Uint8Array(2 * cols * 4 * rows * 3);
  for (let i = 0; i < px.length; i += 3) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  }
  return px;
}

describe('[REQ-RENDER-06] buildAsciiCells', () => {
  it('exports the 10-level ramp, all below 0x80', () => {
    expect(ASCII_RAMP).toBe(' .:-=+*#%@');
    for (const ch of ASCII_RAMP) expect(ch.charCodeAt(0)).toBeLessThan(0x80);
  });

  it('maps black to space and white to @', () => {
    const grid = createCellGrid(1, 1);
    buildAsciiCells(solid(1, 1, 0, 0, 0), 2, 4, grid);
    expect(grid.glyph[0]).toBe(0x20);
    expect(grid.fg[0]).toBe(0);
    expect(grid.bg[0]).toBe(0);

    buildAsciiCells(solid(1, 1, 255, 255, 255), 2, 4, grid);
    expect(String.fromCharCode(grid.glyph[0] ?? 0)).toBe('@');
    expect(grid.fg[0]).toBe(0xffffff);
    expect(grid.bg[0]).toBe(0);
  });

  it('selects ramp[(Y * 10) >> 8] for gray levels', () => {
    const grid = createCellGrid(1, 1);
    for (const gray of [0, 25, 26, 51, 100, 128, 200, 230, 255]) {
      buildAsciiCells(solid(1, 1, gray, gray, gray), 2, 4, grid);
      expect(String.fromCharCode(grid.glyph[0] ?? 0)).toBe(ASCII_RAMP[Math.min(9, (gray * 10) >> 8)]);
    }
  });

  it('uses the cell mean color as foreground', () => {
    const grid = createCellGrid(1, 1);
    // Left column (10,20,30), right column (11,21,31): channel means 10.5 -> 11, 20.5 -> 21, 30.5 -> 31.
    const px = new Uint8Array(2 * 4 * 3);
    for (let y = 0; y < 4; y++) {
      px.set([10, 20, 30, 11, 21, 31], y * 6);
    }
    buildAsciiCells(px, 2, 4, grid);
    expect(grid.fg[0]).toBe((11 << 16) | (21 << 8) | 31);
    expect(grid.bg[0]).toBe(0);
  });

  it('fills each cell from its own block', () => {
    const grid = createCellGrid(2, 1);
    const px = new Uint8Array(4 * 4 * 3);
    // Right cell (pixel columns 2..3) white, left cell black.
    for (let y = 0; y < 4; y++) {
      px.fill(255, (y * 4 + 2) * 3, (y * 4 + 4) * 3);
    }
    buildAsciiCells(px, 4, 4, grid);
    expect(grid.glyph[0]).toBe(0x20);
    expect(grid.glyph[1]).toBe(0x40);
  });

  it('throws RangeError for a wrong decode size', () => {
    const grid = createCellGrid(2, 1);
    expect(() => {
      buildAsciiCells(new Uint8Array(100), 3, 4, grid);
    }).toThrow(RangeError);
    expect(() => {
      buildAsciiCells(new Uint8Array(100), 4, 8, grid);
    }).toThrow(RangeError);
  });

  it('throws RangeError when the pixel buffer is too short', () => {
    const grid = createCellGrid(2, 1);
    expect(() => {
      buildAsciiCells(new Uint8Array(4 * 4 * 3 - 1), 4, 4, grid);
    }).toThrow(RangeError);
  });
});
