// Palettes (REQ-PAL-01). Pure: no I/O. A palette maps a packed 0xRRGGBB color to another packed color.
//
// amber, green and dmg are fixed ramps. apply(rgb) picks the ramp entry whose own luma is closest to
// the luma of the input, through a 256-entry table built once at creation. Because every ramp entry
// maps to itself (its luma is closest to itself) and ramp lumas are strictly increasing, applying a
// palette twice equals applying it once, and output luma never decreases when input luma rises.
//
// Ramps cover the whole luma range: dark tinted shadows, the full phosphor color at entry 11, then
// four highlight steps that blend toward a white-hot tone. Entry lumas are roughly evenly spaced over
// [8, 245], so bright inputs no longer clip to the phosphor peak. A palette test asserts that the
// lumas span at least [16, 240].

import type { Palette } from '../cli/args.ts';
import type { CellGrid } from './cells.ts';
import { lumaPacked } from './luma.ts';

/** Same order as `PALETTES` in src/cli/args.ts (a unit test asserts this). */
export const PALETTE_NAMES = ['truecolor', 'amber', 'green', 'dmg'] as const satisfies readonly Palette[];

export type PaletteName = (typeof PALETTE_NAMES)[number];

export interface PaletteMap {
  readonly name: PaletteName;
  /** Maps a packed 0xRRGGBB color. Result channels are integers in [0, 255]. */
  apply(rgb: number): number;
  /** Maps `fg` and `bg` of every cell in place. */
  applyGrid(grid: CellGrid): void;
}

/**
 * 1978 VT100 amber phosphor: 16 steps. Entries 0-10 are tinted shadows, entry 11 is the full
 * phosphor color #FFB000 (luma 179), entries 12-15 blend toward white-hot #FFF4D6 (luma 244).
 */
export const AMBER_RAMP: readonly number[] = [
  0x0b0800, 0x221700, 0x382600, 0x4e3600, 0x644500, 0x7a5400, 0x906400, 0xa67300,
  0xbd8200, 0xd39100, 0xe9a100, 0xffb000, 0xffc136, 0xffd26b, 0xffe3a1, 0xfff4d6,
];

/**
 * P1 green phosphor: 16 steps. Entries 0-10 are tinted shadows, entry 11 is the full phosphor
 * color #33FF33 (luma 196), entries 12-15 blend toward white-hot #D0FFD0 (luma 241).
 */
export const GREEN_RAMP: readonly number[] = [
  0x020a02, 0x072107, 0x0b370b, 0x0f4d0f, 0x146314, 0x187a18, 0x1d901d, 0x21a621,
  0x26bc26, 0x2ad32a, 0x2fe92f, 0x33ff33, 0x5aff5a, 0x82ff82, 0xa9ffa9, 0xd0ffd0,
];

/** Game Boy (DMG) LCD shades, darkest to lightest. */
export const DMG_RAMP: readonly number[] = [0x0f380f, 0x306230, 0x8bac0f, 0x9bbc0f];

/**
 * Builds a 256-entry luma -> color table. Each luma maps to the ramp entry with the nearest own
 * luma (ties go to the darker entry). Ramp lumas must be strictly increasing.
 */
function buildLumaTable(ramp: readonly number[]): Uint32Array {
  const lumas = ramp.map((c) => lumaPacked(c));
  for (let i = 1; i < lumas.length; i++) {
    if ((lumas[i] ?? 0) <= (lumas[i - 1] ?? 0)) {
      throw new RangeError('palette ramp lumas must be strictly increasing');
    }
  }
  const table = new Uint32Array(256);
  let k = 0;
  for (let y = 0; y < 256; y++) {
    while (k + 1 < ramp.length && Math.abs((lumas[k + 1] ?? 0) - y) < Math.abs((lumas[k] ?? 0) - y)) k++;
    table[y] = ramp[k] ?? 0;
  }
  return table;
}

function createRampPalette(name: PaletteName, ramp: readonly number[]): PaletteMap {
  const table = buildLumaTable(ramp);
  return {
    name,
    apply(rgb: number): number {
      return table[lumaPacked(rgb)] ?? 0;
    },
    applyGrid(grid: CellGrid): void {
      const { fg, bg } = grid;
      for (let i = 0; i < fg.length; i++) {
        fg[i] = table[lumaPacked(fg[i] ?? 0)] ?? 0;
        bg[i] = table[lumaPacked(bg[i] ?? 0)] ?? 0;
      }
    },
  };
}

function createIdentityPalette(): PaletteMap {
  return {
    name: 'truecolor',
    apply(rgb: number): number {
      return rgb & 0xffffff;
    },
    applyGrid(grid: CellGrid): void {
      const { fg, bg } = grid;
      for (let i = 0; i < fg.length; i++) {
        fg[i] = (fg[i] ?? 0) & 0xffffff;
        bg[i] = (bg[i] ?? 0) & 0xffffff;
      }
    },
  };
}

export function createPalette(name: PaletteName): PaletteMap {
  switch (name) {
    case 'truecolor':
      return createIdentityPalette();
    case 'amber':
      return createRampPalette('amber', AMBER_RAMP);
    case 'green':
      return createRampPalette('green', GREEN_RAMP);
    case 'dmg':
      return createRampPalette('dmg', DMG_RAMP);
  }
}
