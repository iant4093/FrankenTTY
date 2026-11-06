import { describe, expect, it } from 'vitest';
import {
  CELL_H,
  CELL_W,
  FRAME_BORDER,
  FRAME_BORDER_COLOR,
  FRAME_TITLE_HEIGHT,
  createRaster,
  drawCell,
  frameWindow,
  getPixel,
  glyphBitmap,
  inkCount,
} from '../../scripts/lib/raster.ts';

const FG = 0x112233;
const BG = 0x445566;

describe('drawCell', () => {
  it('draws the upper half block as fg on the top 8 rows and bg on the bottom 8', () => {
    const r = createRaster(CELL_W, CELL_H, 0xffffff);
    drawCell(r, 0, 0, 0x2580, FG, BG);
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        expect(getPixel(r, x, y)).toBe(y < 8 ? FG : BG);
      }
    }
  });

  it('places a cell at its cell coordinates and leaves neighbors alone', () => {
    const r = createRaster(3 * CELL_W, 2 * CELL_H, 0xabcdef);
    drawCell(r, 1, 1, 0x20, FG, BG);
    expect(getPixel(r, CELL_W, CELL_H)).toBe(BG);
    expect(getPixel(r, 2 * CELL_W - 1, 2 * CELL_H - 1)).toBe(BG);
    expect(getPixel(r, CELL_W - 1, CELL_H)).toBe(0xabcdef);
    expect(getPixel(r, 2 * CELL_W, CELL_H)).toBe(0xabcdef);
  });

  it('draws a Braille cell with dots 1 and 8 (U+2881) as two 3x3 squares', () => {
    const r = createRaster(CELL_W, CELL_H, 0);
    drawCell(r, 0, 0, 0x2881, FG, BG);
    let fgCount = 0;
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) {
        const p = getPixel(r, x, y);
        expect([FG, BG]).toContain(p);
        if (p === FG) fgCount++;
      }
    }
    expect(fgCount).toBe(18);
    // Dot 1: column 0, row 0. Dot 8: column 1, row 3.
    expect(getPixel(r, 0, 0)).toBe(FG);
    expect(getPixel(r, 2, 2)).toBe(FG);
    expect(getPixel(r, 4, 12)).toBe(FG);
    expect(getPixel(r, 6, 14)).toBe(FG);
    expect(getPixel(r, 4, 0)).toBe(BG);
    expect(getPixel(r, 0, 12)).toBe(BG);
  });

  it('draws an empty Braille cell (U+2800) as background only', () => {
    const r = createRaster(CELL_W, CELL_H, 0);
    drawCell(r, 0, 0, 0x2800, FG, BG);
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) expect(getPixel(r, x, y)).toBe(BG);
    }
  });

  it('draws an ASCII glyph in fg over bg', () => {
    const r = createRaster(CELL_W, CELL_H, 0);
    drawCell(r, 0, 0, 0x40, FG, BG);
    let fgCount = 0;
    for (let y = 0; y < CELL_H; y++) {
      for (let x = 0; x < CELL_W; x++) if (getPixel(r, x, y) === FG) fgCount++;
    }
    expect(fgCount).toBe(inkCount(glyphBitmap(0x40) ?? new Uint8Array(0)));
    expect(fgCount).toBeGreaterThan(0);
  });

  it('throws for a glyph it cannot draw', () => {
    const r = createRaster(CELL_W, CELL_H, 0);
    expect(() => drawCell(r, 0, 0, 0x41, FG, BG)).toThrow(RangeError);
  });
});

describe('glyphBitmap', () => {
  it("'@' has ink and ' ' has none", () => {
    expect(inkCount(glyphBitmap(0x40) ?? new Uint8Array(0))).toBeGreaterThan(0);
    expect(inkCount(glyphBitmap(0x20) ?? Uint8Array.of(1))).toBe(0);
  });

  it('has 16 rows for every ramp character and ink grows along the ramp', () => {
    let previous = -1;
    for (const ch of ' .:-=+*#%@') {
      const rows = glyphBitmap(ch.charCodeAt(0));
      expect(rows).toBeDefined();
      expect(rows?.length).toBe(CELL_H);
      const ink = inkCount(rows ?? new Uint8Array(0));
      expect(ink).toBeGreaterThan(previous);
      previous = ink;
    }
  });

  it('is undefined outside the ramp', () => {
    expect(glyphBitmap(0x41)).toBeUndefined();
  });
});

describe('frameWindow', () => {
  it('adds a 24 px border and a 28 px title bar with three traffic-light dots', () => {
    const inner = createRaster(64, 16, 0x123456);
    const out = frameWindow(inner);
    expect(out.width).toBe(64 + 2 * FRAME_BORDER);
    expect(out.height).toBe(16 + FRAME_TITLE_HEIGHT + FRAME_BORDER);
    expect(getPixel(out, 0, out.height - 1)).toBe(FRAME_BORDER_COLOR);
    expect(getPixel(out, FRAME_BORDER, FRAME_TITLE_HEIGHT)).toBe(0x123456);
    expect(getPixel(out, FRAME_BORDER + 15, FRAME_TITLE_HEIGHT + 15)).toBe(0x123456);
    expect(getPixel(out, FRAME_BORDER - 1, FRAME_TITLE_HEIGHT)).toBe(FRAME_BORDER_COLOR);
    expect(getPixel(out, FRAME_BORDER + 6, 14)).toBe(0xff5f57);
    expect(getPixel(out, FRAME_BORDER + 26, 14)).toBe(0xfebc2e);
    expect(getPixel(out, FRAME_BORDER + 46, 14)).toBe(0x28c840);
  });

  it('produces 1008x596 for the 960x544 screenshot area', () => {
    const out = frameWindow(createRaster(960, 544, 0));
    expect(out.width).toBe(1008);
    expect(out.height).toBe(596);
  });
});
