import { describe, expect, it } from 'vitest';
import { PALETTES } from '../../src/cli/args.ts';
import { createCellGrid } from '../../src/renderer/cells.ts';
import { lumaPacked } from '../../src/renderer/luma.ts';
import {
  AMBER_RAMP,
  DMG_RAMP,
  GREEN_RAMP,
  PALETTE_NAMES,
  createPalette,
} from '../../src/renderer/palette.ts';

describe('palette names', () => {
  it('match the CLI PALETTES in the same order', () => {
    expect([...PALETTE_NAMES]).toEqual([...PALETTES]);
  });

  it('createPalette reports its name', () => {
    for (const name of PALETTE_NAMES) expect(createPalette(name).name).toBe(name);
  });
});

describe('truecolor', () => {
  it('is the identity', () => {
    const p = createPalette('truecolor');
    for (const c of [0x000000, 0xffffff, 0x123456, 0xff0080]) expect(p.apply(c)).toBe(c);
  });
});

describe('ramps', () => {
  it('amber and green have 16 entries, dmg has 4', () => {
    expect(AMBER_RAMP).toHaveLength(16);
    expect(GREEN_RAMP).toHaveLength(16);
    expect(DMG_RAMP).toEqual([0x0f380f, 0x306230, 0x8bac0f, 0x9bbc0f]);
  });

  it('amber and green reach their full phosphor color at entry 11 and end white-hot', () => {
    expect(AMBER_RAMP[11]).toBe(0xffb000);
    expect(GREEN_RAMP[11]).toBe(0x33ff33);
    expect(AMBER_RAMP[15]).toBe(0xfff4d6);
    expect(GREEN_RAMP[15]).toBe(0xd0ffd0);
  });

  it('amber and green lumas span at least [16, 240] with no gap wider than 25', () => {
    for (const ramp of [AMBER_RAMP, GREEN_RAMP]) {
      const lumas = ramp.map((c) => lumaPacked(c));
      expect(Math.min(...lumas)).toBeLessThanOrEqual(16);
      expect(Math.max(...lumas)).toBeGreaterThanOrEqual(240);
      for (let i = 1; i < lumas.length; i++) {
        expect((lumas[i] ?? 0) - (lumas[i - 1] ?? 0)).toBeLessThanOrEqual(25);
      }
    }
  });

  it('have strictly increasing luma', () => {
    for (const ramp of [AMBER_RAMP, GREEN_RAMP, DMG_RAMP]) {
      for (let i = 1; i < ramp.length; i++) {
        expect(lumaPacked(ramp[i] ?? 0)).toBeGreaterThan(lumaPacked(ramp[i - 1] ?? 0));
      }
    }
  });

  it('map every entry to itself', () => {
    const cases: [ReturnType<typeof createPalette>, readonly number[]][] = [
      [createPalette('amber'), AMBER_RAMP],
      [createPalette('green'), GREEN_RAMP],
      [createPalette('dmg'), DMG_RAMP],
    ];
    for (const [palette, ramp] of cases) {
      for (const c of ramp) expect(palette.apply(c)).toBe(c);
    }
  });
});

describe('amber and green', () => {
  it('map black to the darkest entry and white to the white-hot top entry', () => {
    expect(createPalette('amber').apply(0x000000)).toBe(0x0b0800);
    expect(createPalette('amber').apply(0xffffff)).toBe(0xfff4d6);
    expect(createPalette('green').apply(0x000000)).toBe(0x020a02);
    expect(createPalette('green').apply(0xffffff)).toBe(0xd0ffd0);
  });

  it('no longer clip bright grays to the phosphor color', () => {
    for (const name of ['amber', 'green'] as const) {
      const p = createPalette(name);
      expect(p.apply(0xe0e0e0)).not.toBe(p.apply(0xffffff));
      expect(p.apply(0xc0c0c0)).not.toBe(p.apply(0xe0e0e0));
    }
  });

  it('use every ramp entry across the 0..255 gray range', () => {
    for (const [name, ramp] of [['amber', AMBER_RAMP], ['green', GREEN_RAMP]] as const) {
      const p = createPalette(name);
      const seen = new Set<number>();
      for (let y = 0; y < 256; y++) seen.add(p.apply((y << 16) | (y << 8) | y));
      expect([...seen].sort((a, b) => a - b)).toEqual([...ramp]);
    }
  });
});

describe('dmg', () => {
  it('uses exactly four colors', () => {
    const p = createPalette('dmg');
    const seen = new Set<number>();
    for (let y = 0; y < 256; y++) seen.add(p.apply((y << 16) | (y << 8) | y));
    expect([...seen].sort((a, b) => a - b)).toEqual([...DMG_RAMP].sort((a, b) => a - b));
  });

  it('maps black to the darkest and white to the lightest shade', () => {
    const p = createPalette('dmg');
    expect(p.apply(0x000000)).toBe(0x0f380f);
    expect(p.apply(0xffffff)).toBe(0x9bbc0f);
  });

  it('splits gray levels at the midpoints between shade lumas', () => {
    const p = createPalette('dmg');
    const gray = (y: number): number => p.apply((y << 16) | (y << 8) | y);
    // Shade lumas are 44, 83, 153, 168, so the boundaries are 63|64, 118|119 and 160|161.
    expect(gray(63)).toBe(0x0f380f);
    expect(gray(64)).toBe(0x306230);
    expect(gray(118)).toBe(0x306230);
    expect(gray(119)).toBe(0x8bac0f);
    expect(gray(160)).toBe(0x8bac0f);
    expect(gray(161)).toBe(0x9bbc0f);
  });
});

describe('applyGrid', () => {
  it('maps fg and bg in place and leaves glyphs alone', () => {
    const grid = createCellGrid(3, 2);
    const inputs = [0x000000, 0xffffff, 0x808080, 0xff0000, 0x00ff00, 0x0000ff];
    for (let i = 0; i < 6; i++) {
      grid.fg[i] = inputs[i] ?? 0;
      grid.bg[i] = inputs[5 - i] ?? 0;
      grid.glyph[i] = 0x2580;
    }
    const p = createPalette('amber');
    p.applyGrid(grid);
    for (let i = 0; i < 6; i++) {
      expect(grid.fg[i]).toBe(p.apply(inputs[i] ?? 0));
      expect(grid.bg[i]).toBe(p.apply(inputs[5 - i] ?? 0));
      expect(grid.glyph[i]).toBe(0x2580);
    }
  });

  it('truecolor leaves the grid unchanged', () => {
    const grid = createCellGrid(2, 1);
    grid.fg[0] = 0x123456;
    grid.bg[1] = 0xabcdef;
    createPalette('truecolor').applyGrid(grid);
    expect(grid.fg[0]).toBe(0x123456);
    expect(grid.bg[1]).toBe(0xabcdef);
  });
});
